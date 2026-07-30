/**
 * cfd-lbm3d-gpu — kernel WGSL D3Q19 + harness WebGPU (BƯỚC 2 của lộ trình 3D).
 *
 * Nguyên tắc kiến trúc:
 *
 * 1. **WGSL được SINH từ đúng bộ hằng số của reference** (`C3X/C3Y/C3Z/W19/OPP19`
 *    trong `cfd-lbm3d.ts`) — không chép tay. Đổi hằng số là kernel đổi theo, và
 *    bài đối chiếu GPU-vs-JS phơi ra ngay.
 * 2. **Thuật toán trùng từng bước với reference.** Kernel fused (một dispatch mỗi
 *    bước) nhưng tương đương chính xác chuỗi stream → inlet → outlet → bounce-back
 *    → collide của JS:
 *      - fluid: pull tuần hoàn; cột x=0 ép f=feq(1,U) rồi vẫn chảy qua collide
 *        (BGK bất động tại cân bằng — reference cũng collide cột inlet);
 *      - outlet x=nx−1: gather như thể đứng ở x=nx−2 rồi collide — trùng "copy
 *        post-stream của nx−2 rồi cả hai cùng collide" của reference;
 *      - solid: giá trị cuối của reference là f_old[i + c_q][OPP[q]] (stream vào
 *        rồi đảo cặp) — kernel pull thẳng dạng đó.
 *    Đối chiếu chấp nhận sai số làm tròn FP32 (JS tính trung gian f64), không
 *    phải "gần đúng vật lý".
 * 3. **File này headless**: không three, không DOM. WebGPU đi qua interface cấu
 *    trúc `GpuDeviceLike` — app đưa device thật vào; node vẫn compile và test
 *    được phần sinh WGSL.
 * 4. **Lực đo ngay trên GPU** (momentum-exchange, atomic fixed-point) — không
 *    đọc buffer f (239 MB ở lưới 192×128×128) về CPU mỗi lần lấy mẫu.
 *
 * Giả định (voxelizer bảo đảm): không có ô solid tại cột x=0 và x=nx−1.
 */

import { C3X, C3Y, C3Z, OPP19, W19 } from "./cfd-lbm3d.js";

const Q3 = 19;
/**
 * Thang fixed-point cho atomic i32 của lực: 2^22 ⇒ lượng tử 2.4e-7, trần ±512
 * đơn vị lattice — lực cản thực tế cỡ ~10 nên dư hơn một bậc.
 */
export const FORCE_FIXED_POINT = 4194304;

// ─── Sinh WGSL ───────────────────────────────────────────────────

export type WgslOptions = {
  /** Hằng số Smagorinsky; null = tắt (nhánh LES bị loại hẳn khỏi shader). */
  smagorinsky?: number | null;
};

const UNIFORMS_WGSL = `struct Uniforms { nx: u32, ny: u32, nz: u32, n: u32, omega: f32, inflow: f32 };
@group(0) @binding(0) var<uniform> uni: Uniforms;`;

const CELL_AT_WGSL = `fn cellAt(xi: i32, yi: i32, zi: i32) -> u32 {
  let nxi = i32(uni.nx); let nyi = i32(uni.ny); let nzi = i32(uni.nz);
  let xw = u32((xi + nxi) % nxi);
  let yw = u32((yi + nyi) % nyi);
  let zw = u32((zi + nzi) % nzi);
  return (zw * uni.ny + yw) * uni.nx + xw;
}`;

export function buildD3q19StepWgsl(options: WgslOptions = {}): string {
  const les = options.smagorinsky ?? null;
  const lines: string[] = [];

  // ─ Solid: g[q] = f_old[i + c_q][OPP[q]] ─
  const solidLines = Array.from({ length: Q3 }, (_, q) =>
    `    fDst[base + ${q}u] = fSrc[cellAt(x + (${C3X[q]}), y + (${C3Y[q]}), z + (${C3Z[q]})) * 19u + ${OPP19[q]}u];`,
  ).join("\n");

  // ─ Gather fluid (pull, tuần hoàn) ─
  for (let q = 0; q < Q3; q += 1) {
    lines.push(`  var g${q} = fSrc[cellAt(gx - (${C3X[q]}), gy - (${C3Y[q]}), gz - (${C3Z[q]})) * 19u + ${q}u];`);
  }

  // ─ Inlet: ép cân bằng tại x=0 (u = (inflow, 0, 0), rho = 1) ─
  lines.push("  if (x == 0) {");
  lines.push("    let inletU2 = 1.5 * uni.inflow * uni.inflow;");
  for (let q = 0; q < Q3; q += 1) {
    const cu = C3X[q] === 0 ? "0.0" : `${C3X[q]}.0 * uni.inflow`;
    lines.push(`    { let cu = 3.0 * (${cu}); g${q} = ${W19[q]} * (1.0 + cu + 0.5 * cu * cu - inletU2); }`);
  }
  lines.push("  }");

  // ─ Moments ─
  lines.push("  var r = 0.0; var jx = 0.0; var jy = 0.0; var jz = 0.0;");
  for (let q = 0; q < Q3; q += 1) {
    const parts = [`r += g${q};`];
    if (C3X[q] !== 0) parts.push(`jx += ${C3X[q] > 0 ? "" : "-"}g${q};`);
    if (C3Y[q] !== 0) parts.push(`jy += ${C3Y[q] > 0 ? "" : "-"}g${q};`);
    if (C3Z[q] !== 0) parts.push(`jz += ${C3Z[q] > 0 ? "" : "-"}g${q};`);
    lines.push(`  ${parts.join(" ")}`);
  }
  lines.push("  let inv = select(1.0, 1.0 / r, r > 0.001);");
  lines.push("  let vx = jx * inv; let vy = jy * inv; let vz = jz * inv;");
  lines.push("  let u2 = 1.5 * (vx * vx + vy * vy + vz * vz);");

  // ─ feq (+ tensor Π nếu LES) ─
  if (les !== null) {
    lines.push("  var pxx = 0.0; var pyy = 0.0; var pzz = 0.0; var pxy = 0.0; var pxz = 0.0; var pyz = 0.0;");
  }
  for (let q = 0; q < Q3; q += 1) {
    const cx = C3X[q], cy = C3Y[q], cz = C3Z[q];
    const cu = [
      cx === 0 ? null : `${cx}.0 * vx`,
      cy === 0 ? null : `${cy}.0 * vy`,
      cz === 0 ? null : `${cz}.0 * vz`,
    ].filter(Boolean).join(" + ") || "0.0";
    lines.push(`  let cu${q} = 3.0 * (${cu}); let feq${q} = ${W19[q]} * r * (1.0 + cu${q} + 0.5 * cu${q} * cu${q} - u2);`);
    if (les !== null && q > 0) {
      const terms: string[] = [];
      if (cx !== 0) terms.push("pxx += neq;");
      if (cy !== 0) terms.push("pyy += neq;");
      if (cz !== 0) terms.push("pzz += neq;");
      if (cx * cy !== 0) terms.push(`pxy += ${cx * cy > 0 ? "" : "-"}neq;`);
      if (cx * cz !== 0) terms.push(`pxz += ${cx * cz > 0 ? "" : "-"}neq;`);
      if (cy * cz !== 0) terms.push(`pyz += ${cy * cz > 0 ? "" : "-"}neq;`);
      lines.push(`  { let neq = g${q} - feq${q}; ${terms.join(" ")} }`);
    }
  }

  // ─ omega hiệu dụng ─
  if (les === null) {
    lines.push("  let omegaEff = uni.omega;");
  } else {
    lines.push("  let piNorm = sqrt(2.0 * (pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz)));");
    lines.push("  let tau0 = 1.0 / uni.omega;");
    lines.push(`  let tauEff = 0.5 * (tau0 + sqrt(tau0 * tau0 + ${(18 * Math.SQRT2 * les * les).toFixed(12)} * piNorm));`);
    lines.push("  let omegaEff = 1.0 / max(tauEff, 0.500001);");
  }
  lines.push("  let omneg = 1.0 - omegaEff;");
  for (let q = 0; q < Q3; q += 1) {
    lines.push(`  fDst[base + ${q}u] = omneg * g${q} + omegaEff * feq${q};`);
  }
  lines.push("  velxyz[i * 3u] = vx; velxyz[i * 3u + 1u] = vy; velxyz[i * 3u + 2u] = vz;");

  return `${UNIFORMS_WGSL}
@group(0) @binding(1) var<storage, read> fSrc: array<f32>;
@group(0) @binding(2) var<storage, read_write> fDst: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
// velxyz: 3 f32 mỗi ô — tracer và mặt cắt cần đủ thành phần, không chỉ |u|.
@group(0) @binding(4) var<storage, read_write> velxyz: array<f32>;

${CELL_AT_WGSL}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= uni.n) { return; }
  let base = i * 19u;
  let x = i32(i % uni.nx);
  let yz = i / uni.nx;
  let y = i32(yz % uni.ny);
  let z = i32(yz / uni.ny);

  if (solid[i] == 1u) {
${solidLines}
    velxyz[i * 3u] = 0.0; velxyz[i * 3u + 1u] = 0.0; velxyz[i * 3u + 2u] = 0.0;
    return;
  }

  // Outlet zero-gradient: gather như thể đứng tại nx−2 rồi collide chung.
  var gx = x;
  if (x == i32(uni.nx) - 1) { gx = x - 1; }
  let gy = y;
  let gz = z;

${lines.join("\n")}
}
`;
}

/** Kernel lực: momentum-exchange tại ô solid, cộng dồn atomic fixed-point. */
export function buildD3q19ForcesWgsl(): string {
  const links: string[] = [];
  for (let q = 1; q < Q3; q += 1) {
    const cx = C3X[q], cy = C3Y[q], cz = C3Z[q];
    const adds: string[] = [];
    if (cx !== 0) adds.push(`      atomicAdd(&forces[0], i32(round(${cx > 0 ? "-" : ""}w)));`);
    if (cy !== 0) adds.push(`      atomicAdd(&forces[1], i32(round(${cy > 0 ? "-" : ""}w)));`);
    if (cz !== 0) adds.push(`      atomicAdd(&forces[2], i32(round(${cz > 0 ? "-" : ""}w)));`);
    links.push(`  {
    let neighbour = cellAt(x + (${cx}), y + (${cy}), z + (${cz}));
    if (solid[neighbour] == 0u) {
      let w = 2.0 * fSrc[base + ${q}u] * ${FORCE_FIXED_POINT}.0;
${adds.join("\n")}
    }
  }`);
  }
  return `${UNIFORMS_WGSL}
@group(0) @binding(1) var<storage, read> fSrc: array<f32>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read_write> forces: array<atomic<i32>, 3>;

${CELL_AT_WGSL}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= uni.n) { return; }
  if (solid[i] == 0u) { return; }
  let x = i32(i % uni.nx);
  // Cùng miền tính với reference: bỏ cột inlet/outlet.
  if (x < 1 || x > i32(uni.nx) - 2) { return; }
  let yz = i / uni.nx;
  let y = i32(yz % uni.ny);
  let z = i32(yz / uni.ny);
  let base = i * 19u;
${links.join("\n")}
}
`;
}

/**
 * Kernel tracer: advect hạt trên GPU bằng nội suy tam tuyến của velxyz.
 *
 * Vì sao trên GPU: three.js render bằng WebGL nên KHÔNG chia sẻ buffer được với
 * WebGPU — đằng nào cũng phải đọc vị trí hạt về CPU để nạp vào BufferAttribute.
 * Nhưng advect trên GPU thì chỉ đọc về 32 B/hạt (1.6 MB cho 50k hạt) thay vì kéo
 * cả trường vận tốc (12·n byte ≈ 18 MB) về CPU mỗi frame.
 *
 * Hạt chết (già, ra ngoài, chui vào solid) tự respawn ở inlet với (y, z, hue)
 * từ hash PCG của (chỉ số hạt, seed) — tiền định theo seed.
 */
export function buildTracerWgsl(): string {
  return `${UNIFORMS_WGSL}
struct TracerUniforms { dt: f32, maxAge: f32, speedScale: f32, seed: u32, count: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(1) var<uniform> tuni: TracerUniforms;
@group(0) @binding(2) var<storage, read> velxyz: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
// 8 f32/hạt: pos.xyz, age, prev.xyz, hue
@group(0) @binding(4) var<storage, read_write> particles: array<f32>;

fn pcg(v: u32) -> u32 {
  var state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rand01(v: u32) -> f32 { return f32(pcg(v)) / 4294967295.0; }

fn velAt(cx: u32, cy: u32, cz: u32) -> vec3f {
  let i = ((cz * uni.ny + cy) * uni.nx + cx) * 3u;
  return vec3f(velxyz[i], velxyz[i + 1u], velxyz[i + 2u]);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p >= tuni.count) { return; }
  let base = p * 8u;
  var pos = vec3f(particles[base], particles[base + 1u], particles[base + 2u]);
  var age = particles[base + 3u];

  let fx = max(vec3f(0.0), min(pos, vec3f(f32(uni.nx) - 1.001, f32(uni.ny) - 1.001, f32(uni.nz) - 1.001)));
  let c0 = vec3u(fx);
  let cellIndex = (c0.z * uni.ny + c0.y) * uni.nx + c0.x;
  let dead = age > tuni.maxAge
    || pos.x >= f32(uni.nx) - 1.5 || pos.x < 0.0
    || pos.y < 0.5 || pos.y >= f32(uni.ny) - 0.5
    || pos.z < 0.5 || pos.z >= f32(uni.nz) - 0.5
    || solid[cellIndex] == 1u;
  if (dead || age < 0.0) {
    // Respawn ở inlet: phủ đều mặt (y, z), hue theo hạt — tiền định theo seed.
    let h = p * 3u + tuni.seed * 2654435761u;
    let ny = rand01(h) * (f32(uni.ny) - 4.0) + 2.0;
    let nz = rand01(h + 1u) * (f32(uni.nz) - 4.0) + 2.0;
    particles[base] = 2.5; particles[base + 1u] = ny; particles[base + 2u] = nz;
    particles[base + 3u] = 0.0;
    particles[base + 4u] = 2.5; particles[base + 5u] = ny; particles[base + 6u] = nz;
    particles[base + 7u] = rand01(h + 2u);
    return;
  }

  particles[base + 4u] = pos.x; particles[base + 5u] = pos.y; particles[base + 6u] = pos.z;
  // Nội suy tam tuyến 8 ô quanh vị trí.
  let frac = fx - vec3f(c0);
  let c1 = min(c0 + vec3u(1u), vec3u(uni.nx - 1u, uni.ny - 1u, uni.nz - 1u));
  let v000 = velAt(c0.x, c0.y, c0.z); let v100 = velAt(c1.x, c0.y, c0.z);
  let v010 = velAt(c0.x, c1.y, c0.z); let v110 = velAt(c1.x, c1.y, c0.z);
  let v001 = velAt(c0.x, c0.y, c1.z); let v101 = velAt(c1.x, c0.y, c1.z);
  let v011 = velAt(c0.x, c1.y, c1.z); let v111 = velAt(c1.x, c1.y, c1.z);
  let v00 = mix(v000, v100, frac.x); let v10 = mix(v010, v110, frac.x);
  let v01 = mix(v001, v101, frac.x); let v11 = mix(v011, v111, frac.x);
  let velocity = mix(mix(v00, v10, frac.y), mix(v01, v11, frac.y), frac.z);

  pos = pos + velocity * tuni.speedScale * tuni.dt;
  particles[base] = pos.x; particles[base + 1u] = pos.y; particles[base + 2u] = pos.z;
  particles[base + 3u] = age + tuni.dt;
}
`;
}

// ─── Interface cấu trúc cho WebGPU (không phụ thuộc @webgpu/types) ───
// Chỉ khai báo đúng bề mặt API harness dùng — compile được cả trong node.

export type GpuBufferLike = {
  size: number;
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
};
type GpuBindGroupLike = unknown;
type GpuPipelineLike = { getBindGroupLayout(index: number): unknown };
type GpuPassLike = {
  setPipeline(pipeline: GpuPipelineLike): void;
  setBindGroup(index: number, group: GpuBindGroupLike): void;
  dispatchWorkgroups(count: number): void;
  end(): void;
};
type GpuEncoderLike = {
  beginComputePass(): GpuPassLike;
  copyBufferToBuffer(src: GpuBufferLike, srcOffset: number, dst: GpuBufferLike, dstOffset: number, size: number): void;
  finish(): unknown;
};
export type GpuDeviceLike = {
  limits: { maxStorageBufferBindingSize: number };
  queue: {
    writeBuffer(buffer: GpuBufferLike, offset: number, data: ArrayBufferView | ArrayBuffer): void;
    submit(buffers: unknown[]): void;
    onSubmittedWorkDone(): Promise<void>;
  };
  createBuffer(desc: { size: number; usage: number }): GpuBufferLike;
  createShaderModule(desc: { code: string }): unknown;
  createComputePipeline(desc: { layout: "auto"; compute: { module: unknown; entryPoint: string } }): GpuPipelineLike;
  createBindGroup(desc: { layout: unknown; entries: Array<{ binding: number; resource: { buffer: GpuBufferLike } }> }): GpuBindGroupLike;
  createCommandEncoder(): GpuEncoderLike;
};

// GPUBufferUsage/GPUMapMode là hằng chuẩn WebGPU — ghi literal vì node không có global.
const USAGE_MAP_READ = 0x0001;
const USAGE_COPY_SRC = 0x0004;
const USAGE_COPY_DST = 0x0008;
const USAGE_UNIFORM = 0x0040;
const USAGE_STORAGE = 0x0080;
const MAP_READ = 0x0001;

// ─── Harness ─────────────────────────────────────────────────────

export type Lbm3dGpu = {
  nx: number;
  ny: number;
  nz: number;
  n: number;
  /** Nạp trạng thái khởi tạo TỪ reference — hai bên cùng một xuất phát điểm. */
  upload(f: Float32Array, solid: Uint8Array): void;
  setParams(omega: number, inflow: number): void;
  /** Chạy `count` bước trong một lần submit; chờ GPU xong. */
  steps(count: number): Promise<void>;
  readF(): Promise<Float32Array>;
  /** Trường vận tốc đầy đủ: 3 f32/ô (ux, uy, uz). */
  readVelocity(): Promise<Float32Array>;
  /** Một lát z (nx×ny×3 f32) — copy dải liên tục, rẻ hơn cả trường ~nz lần. */
  readVelocitySliceZ(z: number): Promise<Float32Array>;
  readForces(): Promise<{ fx: number; fy: number; fz: number }>;
  /** Cấp phát `count` tracer advect trên GPU. Gọi một lần trước advectTracers. */
  initTracers(count: number): void;
  /** Advect tracer theo trường vận tốc hiện tại; `dtSteps` = số bước sim trôi qua. */
  advectTracers(dtSteps: number, seed: number): Promise<void>;
  /** Đọc tracer: 8 f32/hạt (pos.xyz, age, prev.xyz, hue). */
  readTracers(): Promise<Float32Array>;
  destroy(): void;
};

export function createLbm3dGpu(
  device: GpuDeviceLike,
  nx: number,
  ny: number,
  nz: number,
  options: WgslOptions = {},
): Lbm3dGpu {
  const n = nx * ny * nz;
  const fBytes = n * Q3 * 4;
  if (fBytes > device.limits.maxStorageBufferBindingSize) {
    throw new Error(`lưới cần ${(fBytes / 1048576).toFixed(0)} MB/buffer, vượt giới hạn adapter ${(device.limits.maxStorageBufferBindingSize / 1048576).toFixed(0)} MB`);
  }
  const f0 = device.createBuffer({ size: fBytes, usage: USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC });
  const f1 = device.createBuffer({ size: fBytes, usage: USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC });
  const solidBuf = device.createBuffer({ size: n * 4, usage: USAGE_STORAGE | USAGE_COPY_DST });
  const velBuf = device.createBuffer({ size: n * 12, usage: USAGE_STORAGE | USAGE_COPY_SRC });
  const forcesBuf = device.createBuffer({ size: 12, usage: USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC });
  const uniforms = device.createBuffer({ size: 32, usage: USAGE_UNIFORM | USAGE_COPY_DST });
  device.queue.writeBuffer(uniforms, 0, new Uint32Array([nx, ny, nz, n]));

  const stepPipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: buildD3q19StepWgsl(options) }), entryPoint: "main" },
  });
  const forcesPipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: buildD3q19ForcesWgsl() }), entryPoint: "main" },
  });
  const stepBind = (src: GpuBufferLike, dst: GpuBufferLike) => device.createBindGroup({
    layout: stepPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: { buffer: src } },
      { binding: 2, resource: { buffer: dst } },
      { binding: 3, resource: { buffer: solidBuf } },
      { binding: 4, resource: { buffer: velBuf } },
    ],
  });
  const bindA = stepBind(f0, f1);
  const bindB = stepBind(f1, f0);
  const forcesBindFor = (src: GpuBufferLike) => device.createBindGroup({
    layout: forcesPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: { buffer: src } },
      { binding: 2, resource: { buffer: solidBuf } },
      { binding: 3, resource: { buffer: forcesBuf } },
    ],
  });
  const forcesBindA = forcesBindFor(f0);
  const forcesBindB = forcesBindFor(f1);

  const groups = Math.ceil(n / 256);
  let flip = false;

  // Tracer: cấp phát lười — nhiều người dùng chỉ chạy solver không cần hạt.
  let tracerBuf: GpuBufferLike | null = null;
  let tracerUni: GpuBufferLike | null = null;
  let tracerPipeline: GpuPipelineLike | null = null;
  let tracerBind: GpuBindGroupLike | null = null;
  let tracerCount = 0;

  const readBuffer = async (buffer: GpuBufferLike, bytes: number) => {
    const staging = device.createBuffer({ size: bytes, usage: USAGE_COPY_DST | USAGE_MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(MAP_READ);
    const data = staging.getMappedRange().slice(0);
    staging.destroy();
    return data;
  };

  return {
    nx, ny, nz, n,
    upload(f, solid) {
      device.queue.writeBuffer(f0, 0, f);
      const packed = new Uint32Array(n);
      for (let i = 0; i < n; i += 1) packed[i] = solid[i];
      device.queue.writeBuffer(solidBuf, 0, packed);
      flip = false;
    },
    setParams(omega, inflow) {
      device.queue.writeBuffer(uniforms, 16, new Float32Array([omega, inflow]));
    },
    async steps(count) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(stepPipeline);
      for (let s = 0; s < count; s += 1) {
        pass.setBindGroup(0, flip ? bindB : bindA);
        pass.dispatchWorkgroups(groups);
        flip = !flip;
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    },
    async readF() {
      return new Float32Array(await readBuffer(flip ? f1 : f0, fBytes));
    },
    async readVelocity() {
      return new Float32Array(await readBuffer(velBuf, n * 12));
    },
    async readVelocitySliceZ(z) {
      // Lát z là dải LIÊN TỤC trong layout (z·ny + y)·nx + x → một lệnh copy
      // 12·nx·ny byte thay vì kéo cả trường (12·n byte) về CPU.
      const bytes = nx * ny * 12;
      const staging = device.createBuffer({ size: bytes, usage: USAGE_COPY_DST | USAGE_MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(velBuf, z * bytes, staging, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(MAP_READ);
      const data = staging.getMappedRange().slice(0);
      staging.destroy();
      return new Float32Array(data);
    },
    initTracers(count) {
      tracerCount = count;
      tracerBuf = device.createBuffer({ size: count * 32, usage: USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC });
      tracerUni = device.createBuffer({ size: 32, usage: USAGE_UNIFORM | USAGE_COPY_DST });
      // age = -1 ⇒ mọi hạt respawn ngay lần advect đầu (nhánh dead || age < 0).
      const seedData = new Float32Array(count * 8);
      for (let particle = 0; particle < count; particle += 1) seedData[particle * 8 + 3] = -1;
      device.queue.writeBuffer(tracerBuf, 0, seedData);
      tracerPipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module: device.createShaderModule({ code: buildTracerWgsl() }), entryPoint: "main" },
      });
      tracerBind = device.createBindGroup({
        layout: tracerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: { buffer: tracerUni } },
          { binding: 2, resource: { buffer: velBuf } },
          { binding: 3, resource: { buffer: solidBuf } },
          { binding: 4, resource: { buffer: tracerBuf } },
        ],
      });
    },
    async advectTracers(dtSteps, seed) {
      if (!tracerPipeline || !tracerUni || !tracerBind) throw new Error("gọi initTracers trước");
      const uniData = new ArrayBuffer(32);
      new Float32Array(uniData, 0, 3).set([dtSteps, 620, 1]);
      new Uint32Array(uniData, 12, 2).set([seed >>> 0, tracerCount]);
      device.queue.writeBuffer(tracerUni, 0, uniData);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(tracerPipeline);
      pass.setBindGroup(0, tracerBind);
      pass.dispatchWorkgroups(Math.ceil(tracerCount / 256));
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    },
    async readTracers() {
      if (!tracerBuf) throw new Error("gọi initTracers trước");
      return new Float32Array(await readBuffer(tracerBuf, tracerCount * 32));
    },
    async readForces() {
      device.queue.writeBuffer(forcesBuf, 0, new Int32Array([0, 0, 0]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(forcesPipeline);
      pass.setBindGroup(0, flip ? forcesBindB : forcesBindA);
      pass.dispatchWorkgroups(groups);
      pass.end();
      device.queue.submit([encoder.finish()]);
      const raw = new Int32Array(await readBuffer(forcesBuf, 12));
      return { fx: raw[0] / FORCE_FIXED_POINT, fy: raw[1] / FORCE_FIXED_POINT, fz: raw[2] / FORCE_FIXED_POINT };
    },
    destroy() {
      f0.destroy(); f1.destroy(); solidBuf.destroy(); velBuf.destroy(); forcesBuf.destroy(); uniforms.destroy();
      tracerBuf?.destroy(); tracerUni?.destroy();
    },
  };
}
