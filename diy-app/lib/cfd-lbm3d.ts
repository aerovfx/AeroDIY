/**
 * cfd-lbm3d — solver Lattice Boltzmann D3Q19 reference (Navier–Stokes 3D).
 *
 * Đây là BƯỚC 1 của lộ trình 3D: bản JS thuần, headless, chậm (~11 MLUPS) nhưng
 * là NGUỒN SỰ THẬT về thuật toán — bộ test mốc quả cầu chạy trên nó, và kernel
 * WebGPU ở bước 2 sẽ được đối chiếu từng giá trị với nó (spike đã chứng minh cách
 * đối chiếu này hoạt động: max|Δf| = 3.3e-7 sau 20 bước).
 *
 * Khác biệt có chủ đích so với `cfd-lbm.ts` (2D):
 *
 * 1. **Trục y hướng LÊN.** Bản 2D lật y theo màn hình canvas nên lực nâng là
 *    −fy; lib 3D không phục vụ trực tiếp canvas nên chọn hệ thuận: CAD (X,Y,Z)
 *    map thẳng sang lattice (x,y,z), lực nâng = +fy. KHÔNG trộn hai quy ước.
 * 2. **Biên ngang (y, z) tuần hoàn** — tương đương một mảng vật thể cách đều
 *    (spanwise-periodic), không phải vật thể tự do. Cd đo được cao hơn không
 *    gian tự do một chút tuỳ khoảng cách ảnh; con số này được báo qua
 *    `latticeSpacingDiameters` để người đọc tự đánh giá.
 * 3. **Diện tích tham chiếu là DIỆN TÍCH CẢN THẬT** (đếm ô chiếu theo dòng),
 *    không phải bề dày × trục thứ ba như 2D — Cd 3D so thẳng được với đường
 *    cong quả cầu trong sách.
 * 4. Chiều dài đặc trưng D = đường kính tương đương sqrt(4A/π) — với quả cầu
 *    trùng đúng đường kính.
 *
 * Mốc kiểm chứng (Schiller–Naumann / đường cong chuẩn): quả cầu Re=100
 * Cd ≈ 1.09 · Re=300 ≈ 0.68 · Re=1000 ≈ 0.45.
 */

import { seededRandom } from "./cfd-lbm.js";
import type { ScenePrimitive } from "./cad-engine.js";

// ─── Bộ vận tốc D3Q19 ────────────────────────────────────────────
// THỨ TỰ CỐ ĐỊNH — kernel WGSL bước 2 sinh code từ đúng các mảng này để đối
// chiếu được từng giá trị. Đổi thứ tự là phá tính so sánh bit.
export const C3X = [0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0] as const;
export const C3Y = [0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1] as const;
export const C3Z = [0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1] as const;
export const OPP19 = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17] as const;
export const W19 = [
  1 / 3,
  1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18,
  1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36,
] as const;
const Q3 = 19;

export type Lbm3dState = {
  nx: number;
  ny: number;
  nz: number;
  n: number;
  f: Float32Array;
  fNew: Float32Array;
  solid: Uint8Array;
  rho: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
  /** Bảng chỉ số nguồn streaming pull (tuần hoàn cả 3 trục). */
  streamSrc: Int32Array;
  step: number;
};

export function cellIndex3d(state: { nx: number; ny: number }, x: number, y: number, z: number) {
  return (z * state.ny + y) * state.nx + x;
}

export function createLbm3d(nx: number, ny: number, nz: number): Lbm3dState {
  const n = nx * ny * nz;
  const streamSrc = new Int32Array(n * Q3);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const target = (z * ny + y) * nx + x;
        for (let q = 0; q < Q3; q += 1) {
          const xs = (x - C3X[q] + nx) % nx;
          const ys = (y - C3Y[q] + ny) % ny;
          const zs = (z - C3Z[q] + nz) % nz;
          streamSrc[target * Q3 + q] = ((zs * ny + ys) * nx + xs) * Q3 + q;
        }
      }
    }
  }
  return {
    nx, ny, nz, n,
    f: new Float32Array(n * Q3),
    fNew: new Float32Array(n * Q3),
    solid: new Uint8Array(n),
    rho: new Float32Array(n),
    ux: new Float32Array(n),
    uy: new Float32Array(n),
    uz: new Float32Array(n),
    streamSrc,
    step: 0,
  };
}

function equilibrium19(out: Float64Array, rho: number, ux: number, uy: number, uz: number) {
  const u2 = 1.5 * (ux * ux + uy * uy + uz * uz);
  for (let q = 0; q < Q3; q += 1) {
    const cu = 3 * (C3X[q] * ux + C3Y[q] * uy + C3Z[q] * uz);
    out[q] = W19[q] * rho * (1 + cu + 0.5 * cu * cu - u2);
  }
}

const scratchEq = new Float64Array(Q3);

/**
 * Phân bố cân bằng ĐỒNG NHẤT cho khởi tạo GPU lưới lớn: không cần dựng
 * `createLbm3d` (bảng streamSrc ~239 MB ở lưới 192×128×128 chỉ để... vứt đi,
 * vì GPU tự tính chỉ số lân cận). Không nhiễu — tiền định tuyệt đối.
 */
export function uniformEquilibrium3d(cellCount: number, inflowU: number): Float32Array {
  const f = new Float32Array(cellCount * Q3);
  equilibrium19(scratchEq, 1, inflowU, 0, 0);
  for (let i = 0; i < cellCount; i += 1) {
    for (let q = 0; q < Q3; q += 1) f[i * Q3 + q] = scratchEq[q];
  }
  return f;
}

export function initLbm3d(state: Lbm3dState, inflowU: number, noise = 0.01, random: () => number = Math.random) {
  const { f, rho, ux, uy, uz, n } = state;
  for (let i = 0; i < n; i += 1) {
    const vx = inflowU + (random() - 0.5) * noise;
    const vy = (random() - 0.5) * noise;
    const vz = (random() - 0.5) * noise;
    rho[i] = 1; ux[i] = vx; uy[i] = vy; uz[i] = vz;
    equilibrium19(scratchEq, 1, vx, vy, vz);
    for (let q = 0; q < Q3; q += 1) f[i * Q3 + q] = scratchEq[q];
  }
  state.step = 0;
}

/**
 * Nửa bước 1: streaming pull + biên. Thứ tự và cấu trúc giống hệt bản 2D
 * (stream → inlet → outlet → bounce-back vật cản) để giữ tính bất biến thời
 * điểm đo lực: `collide3d` không đụng ô solid nên momentum-exchange đo trước
 * hay sau collision đều cho cùng kết quả.
 *
 * Biên: inlet x=0 ép cân bằng (rho=1, u=inflow); outlet x=nx−1 zero-gradient;
 * y và z TUẦN HOÀN (spanwise-periodic — xem ghi chú đầu file).
 */
export function streamAndApplyBoundaries3d(state: Lbm3dState, inflowU: number) {
  const { nx, ny, nz, n, solid, streamSrc } = state;
  let f = state.f;
  const fNew = state.fNew;

  for (let i = 0; i < n; i += 1) {
    const base = i * Q3;
    for (let q = 0; q < Q3; q += 1) fNew[base + q] = f[streamSrc[base + q]];
  }
  const tmp = state.f;
  state.f = state.fNew;
  state.fNew = tmp;
  f = state.f;

  // Inlet x=0: feq(1, inflow, 0, 0) — hằng theo (y,z), tính một lần.
  equilibrium19(scratchEq, 1, inflowU, 0, 0);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const base = ((z * ny + y) * nx) * Q3;
      for (let q = 0; q < Q3; q += 1) f[base + q] = scratchEq[q];
    }
  }
  // Outlet x=nx−1: zero-gradient.
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const row = (z * ny + y) * nx;
      const baseR = (row + nx - 1) * Q3;
      const baseL = (row + nx - 2) * Q3;
      for (let q = 0; q < Q3; q += 1) f[baseR + q] = f[baseL + q];
    }
  }
  // Vật cản: bounce-back — đảo từng cặp hướng đối tại ô solid.
  for (let i = 0; i < n; i += 1) {
    if (!solid[i]) continue;
    const base = i * Q3;
    for (let q = 1; q < Q3; q += 2) {
      const t = f[base + q];
      f[base + q] = f[base + q + 1];
      f[base + q + 1] = t;
    }
  }
}

/**
 * Nửa bước 2: macroscopic + collision BGK, tuỳ chọn Smagorinsky LES.
 *
 * LES 3D dùng đủ 6 thành phần tensor ứng suất ngoài cân bằng — bài học từ 2D:
 * moment kiểu m7 là Πxx−Πyy chứ không phải Πxx, tính thiếu thành phần là hệ số
 * nhớt xoáy sai. Ở đây tính Π trực tiếp từ f−feq nên không có bẫy đó.
 */
export function collide3d(state: Lbm3dState, omega: number, lesConstant: number | null = null) {
  const { n, solid, rho, ux, uy, uz } = state;
  const f = state.f;
  for (let i = 0; i < n; i += 1) {
    if (solid[i]) { rho[i] = 1; ux[i] = 0; uy[i] = 0; uz[i] = 0; continue; }
    const base = i * Q3;
    let r = 0, jx = 0, jy = 0, jz = 0;
    for (let q = 0; q < Q3; q += 1) {
      const v = f[base + q];
      r += v; jx += C3X[q] * v; jy += C3Y[q] * v; jz += C3Z[q] * v;
    }
    const inv = r > 0.001 ? 1 / r : 1;
    const vx = jx * inv, vy = jy * inv, vz = jz * inv;
    rho[i] = r; ux[i] = vx; uy[i] = vy; uz[i] = vz;
    equilibrium19(scratchEq, r, vx, vy, vz);

    let omegaEff = omega;
    if (lesConstant !== null) {
      let pxx = 0, pyy = 0, pzz = 0, pxy = 0, pxz = 0, pyz = 0;
      for (let q = 1; q < Q3; q += 1) {
        const neq = f[base + q] - scratchEq[q];
        pxx += C3X[q] * C3X[q] * neq;
        pyy += C3Y[q] * C3Y[q] * neq;
        pzz += C3Z[q] * C3Z[q] * neq;
        pxy += C3X[q] * C3Y[q] * neq;
        pxz += C3X[q] * C3Z[q] * neq;
        pyz += C3Y[q] * C3Z[q] * neq;
      }
      const norm = Math.sqrt(2 * (pxx * pxx + pyy * pyy + pzz * pzz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz)));
      const tau0 = 1 / omega;
      const tauEff = 0.5 * (tau0 + Math.sqrt(tau0 * tau0 + 18 * Math.SQRT2 * lesConstant * lesConstant * norm));
      omegaEff = 1 / Math.max(tauEff, 0.5 + 1e-6);
    }
    const omneg = 1 - omegaEff;
    for (let q = 0; q < Q3; q += 1) {
      f[base + q] = omneg * f[base + q] + omegaEff * scratchEq[q];
    }
  }
  state.step += 1;
}

export type Step3dOptions = { smagorinsky?: number | null };

export function stepLbm3d(state: Lbm3dState, omega: number, inflowU: number, options: Step3dOptions = {}) {
  streamAndApplyBoundaries3d(state, inflowU);
  collide3d(state, omega, options.smagorinsky ?? null);
}

// ─── Vật cản giải tích cho benchmark ─────────────────────────────

export function presetSphere3d(state: Lbm3dState, cx: number, cy: number, cz: number, r: number) {
  const { nx, ny, nz, solid } = state;
  for (let z = Math.max(0, Math.floor(cz - r) - 1); z <= Math.min(nz - 1, Math.ceil(cz + r) + 1); z += 1) {
    for (let y = Math.max(0, Math.floor(cy - r) - 1); y <= Math.min(ny - 1, Math.ceil(cy + r) + 1); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - r) - 1); x <= Math.min(nx - 1, Math.ceil(cx + r) + 1); x += 1) {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        if (dx * dx + dy * dy + dz * dz < r * r) solid[(z * ny + y) * nx + x] = 1;
      }
    }
  }
}

/** Ellipsoid bán trục (a dọc dòng, b đứng, c ngang) — thân thuôn khi a > b,c. */
export function presetEllipsoid3d(state: Lbm3dState, cx: number, cy: number, cz: number, a: number, b: number, c: number) {
  const { nx, ny, nz, solid } = state;
  for (let z = Math.max(0, Math.floor(cz - c) - 1); z <= Math.min(nz - 1, Math.ceil(cz + c) + 1); z += 1) {
    for (let y = Math.max(0, Math.floor(cy - b) - 1); y <= Math.min(ny - 1, Math.ceil(cy + b) + 1); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - a) - 1); x <= Math.min(nx - 1, Math.ceil(cx + a) + 1); x += 1) {
        const dx = (x - cx) / a, dy = (y - cy) / b, dz = (z - cz) / c;
        if (dx * dx + dy * dy + dz * dz < 1) solid[(z * ny + y) * nx + x] = 1;
      }
    }
  }
}

// ─── Đo đạc ──────────────────────────────────────────────────────

/**
 * Diện tích cản: đếm cột (y,z) có ít nhất một ô solid dọc theo dòng.
 * Đây là diện tích chiếu THẬT — mẫu số của Cd 3D.
 */
export function frontalProjection3d(state: Lbm3dState) {
  const { nx, ny, nz, solid } = state;
  let cells = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x += 1) {
        if (solid[row + x]) { cells += 1; break; }
      }
    }
  }
  return cells;
}

/** Đường kính tương đương từ diện tích cản — với quả cầu trùng đúng đường kính. */
export function equivalentDiameter3d(frontalCells: number) {
  return Math.sqrt((4 * frontalCells) / Math.PI);
}

export type Forces3d = { fx: number; fy: number; fz: number };

/**
 * Momentum exchange tại Ô SOLID (như 2D): với mỗi hướng q có ô lân cận là
 * fluid, f_q sau bounce-back là phân bố vừa phản xạ — lực lên vật là −2·c_q·f_q.
 * Bất biến với thời điểm gọi trong bước vì collide3d bỏ qua ô solid.
 */
export function momentumExchangeForces3d(state: Lbm3dState): Forces3d {
  const { nx, ny, nz, solid, f } = state;
  let fx = 0, fy = 0, fz = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 1; x < nx - 1; x += 1) {
        const i = (z * ny + y) * nx + x;
        if (!solid[i]) continue;
        const base = i * Q3;
        for (let q = 1; q < Q3; q += 1) {
          // y/z tuần hoàn nên lân cận wrap qua biên vẫn hợp lệ.
          const xn = x + C3X[q];
          const yn = (y + C3Y[q] + ny) % ny;
          const zn = (z + C3Z[q] + nz) % nz;
          if (solid[(zn * ny + yn) * nx + xn]) continue;
          const w = 2 * f[base + q];
          fx -= C3X[q] * w;
          fy -= C3Y[q] * w;
          fz -= C3Z[q] * w;
        }
      }
    }
  }
  return { fx, fy, fz };
}

// ─── Voxelizer: scene CAD → lưới 3D ──────────────────────────────

const ROUND_KINDS = new Set<ScenePrimitive["kind"]>(["cylinder", "motor", "sphere", "cone", "tube", "lathe"]);
const SKIP_KINDS = new Set<ScenePrimitive["kind"]>(["wire", "screw"]);

export type Voxelize3dOptions = {
  /** Số ô mục tiêu cho bề dày MỎNG NHẤT trong hai chiều cắt dòng (y, z). */
  crossStreamCells?: number;
  /** Ngân sách chiều dọc dòng [ô]. */
  chordCells?: number;
  /** Góc tấn (độ, mũi lên dương) — xoay quanh trục z. */
  angleOfAttackDeg?: number;
  /** Bán kính đóng hình thái học 3D; 0 = tắt. */
  closeRadius?: number;
  minFeatureCells?: number;
};

/**
 * Phép biến đổi mm(đã xoay AOA) → lattice, đủ để viewport đặt mesh CAD, mặt cắt
 * và tracer vào CÙNG một hệ toạ độ:
 *   lattice = originLattice + (Rz(−aoa)·p_mm − originMm) · scale
 */
export type LatticeFromMm = {
  /** ô lưới trên mỗi mm (= 1/cellSizeMm). */
  scale: number;
  originMm: [number, number, number];
  originLattice: [number, number, number];
  angleOfAttackRad: number;
};

export type Voxelize3dResult = {
  solidCells: number;
  frontalCells: number;
  characteristicCells: number;
  bbox: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null;
  cellSizeMm: number;
  extentsMm: [number, number, number];
  latticeFromMm: LatticeFromMm;
  skipped: string[];
  usedPrimitives: number;
};

/**
 * Đóng hình thái học 3D (dilate rồi erode, phần tử cấu trúc hình cầu) — cùng lý
 * do với 2D: scene CAD voxel hoá ra nhiều mảnh rời, dòng lách qua kẽ thì vừa
 * sai vật lý vừa trông như mảnh vụn.
 */
export function closeSolidMask3d(state: Lbm3dState, radius: number) {
  if (radius <= 0) return;
  const { nx, ny, nz, n } = state;
  const offsets: number[] = [];
  for (let dz = -radius; dz <= radius; dz += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy + dz * dz <= radius * radius) offsets.push((dz * ny + dy) * nx + dx);
      }
    }
  }
  const inRange = (x: number, y: number, z: number) =>
    x >= radius && x < nx - radius && y >= radius && y < ny - radius && z >= radius && z < nz - radius;
  const dilated = new Uint8Array(n);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const i = (z * ny + y) * nx + x;
        if (!state.solid[i] || !inRange(x, y, z)) continue;
        for (const offset of offsets) dilated[i + offset] = 1;
      }
    }
  }
  const eroded = new Uint8Array(n);
  for (let z = radius; z < nz - radius; z += 1) {
    for (let y = radius; y < ny - radius; y += 1) {
      for (let x = radius; x < nx - radius; x += 1) {
        const i = (z * ny + y) * nx + x;
        let all = 1;
        for (const offset of offsets) {
          if (!dilated[i + offset]) { all = 0; break; }
        }
        eroded[i] = all;
      }
    }
  }
  for (let i = 0; i < n; i += 1) if (eroded[i]) state.solid[i] = 1;
}

export function voxelizeScene(state: Lbm3dState, scene: ScenePrimitive[], options: Voxelize3dOptions = {}): Voxelize3dResult {
  const { nx, ny, nz } = state;
  const crossTarget = Math.max(6, options.crossStreamCells ?? Math.max(12, Math.round(ny * 0.1)));
  const chordBudget = Math.max(8, options.chordCells ?? Math.round(nx * 0.55));
  const minFeature = options.minFeatureCells ?? 0.9;
  const theta = ((options.angleOfAttackDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);

  type Footprint = { id: string; x: number; y: number; z: number; hx: number; hy: number; hz: number; round: boolean };
  const footprints: Footprint[] = [];
  const skipped: string[] = [];
  for (const primitive of scene) {
    if (SKIP_KINDS.has(primitive.kind) || primitive.role === "cutout") { skipped.push(primitive.id); continue; }
    if (primitive.opacity !== undefined && primitive.opacity < 0.35) { skipped.push(primitive.id); continue; }
    const hx = Math.abs(primitive.size[0]) / 2;
    const hy = Math.abs(primitive.size[1]) / 2;
    const hz = Math.abs(primitive.size[2]) / 2;
    if (hx <= 0 || hy <= 0 || hz <= 0) { skipped.push(primitive.id); continue; }
    footprints.push({ id: primitive.id, x: primitive.position[0], y: primitive.position[1], z: primitive.position[2], hx, hy, hz, round: ROUND_KINDS.has(primitive.kind) });
  }
  if (footprints.length === 0) {
    return { solidCells: 0, frontalCells: 0, characteristicCells: 0, bbox: null, cellSizeMm: 1, extentsMm: [0, 0, 0], latticeFromMm: { scale: 1, originMm: [0, 0, 0], originLattice: [0, 0, 0], angleOfAttackRad: theta }, skipped, usedPrimitives: 0 };
  }

  // Xoay góc tấn quanh trục z (y hướng LÊN): xr = cx+sy, yr = −sx+cy.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const rotated = footprints.map((fp) => {
    const xr = cos * fp.x + sin * fp.y;
    const yr = -sin * fp.x + cos * fp.y;
    const halfX = Math.abs(cos) * fp.hx + Math.abs(sin) * fp.hy;
    const halfY = Math.abs(sin) * fp.hx + Math.abs(cos) * fp.hy;
    minX = Math.min(minX, xr - halfX); maxX = Math.max(maxX, xr + halfX);
    minY = Math.min(minY, yr - halfY); maxY = Math.max(maxY, yr + halfY);
    minZ = Math.min(minZ, fp.z - fp.hz); maxZ = Math.max(maxZ, fp.z + fp.hz);
    return { ...fp, xr, yr, halfX, halfY };
  });
  const extentX = Math.max(maxX - minX, 0.001);
  const extentY = Math.max(maxY - minY, 0.001);
  const extentZ = Math.max(maxZ - minZ, 0.001);
  // Tỷ lệ: phân giải bề dày MỎNG NHẤT (thường là lớp biên quyết định), nhưng
  // không cho bóng vượt 75% miền theo bất kỳ trục cắt dòng nào, và không vượt
  // ngân sách chiều dòng.
  const thinnest = Math.min(extentY, extentZ);
  const scale = Math.max(
    Math.min(crossTarget / thinnest, (ny * 0.75) / extentY, (nz * 0.75) / extentZ, chordBudget / extentX),
    4 / extentX,
  );
  const cellSizeMm = 1 / scale;
  const originX = 0.3 * nx - (extentX * scale) / 2;
  const midY = (minY + maxY) / 2, midZ = (minZ + maxZ) / 2;

  let usedPrimitives = 0;
  for (const fp of rotated) {
    const sx = Math.max(fp.hx * scale, 0.5);
    const sy = Math.max(fp.hy * scale, 0.5);
    const sz = Math.max(fp.hz * scale, 0.5);
    if (Math.max(sx, sy, sz) * 2 < minFeature) { skipped.push(fp.id); continue; }
    const cx = originX + (fp.xr - minX) * scale;
    const cy = ny / 2 + (fp.yr - midY) * scale;
    const cz = nz / 2 + (fp.z - midZ) * scale;
    const rx = fp.halfX * scale, ry = fp.halfY * scale;
    for (let z = Math.max(0, Math.floor(cz - sz - 1)); z <= Math.min(nz - 1, Math.ceil(cz + sz + 1)); z += 1) {
      for (let y = Math.max(0, Math.floor(cy - ry - 1)); y <= Math.min(ny - 1, Math.ceil(cy + ry + 1)); y += 1) {
        for (let x = Math.max(0, Math.floor(cx - rx - 1)); x <= Math.min(nx - 1, Math.ceil(cx + rx + 1)); x += 1) {
          // Nghịch đảo phép xoay để kiểm tra trong hệ thân.
          const dx = x - cx, dy = y - cy, dz = z - cz;
          const bx = cos * dx - sin * dy;
          const by = sin * dx + cos * dy;
          const inside = fp.round
            ? (bx / sx) * (bx / sx) + (by / sy) * (by / sy) + (dz / sz) * (dz / sz) < 1
            : Math.abs(bx) <= sx && Math.abs(by) <= sy && Math.abs(dz) <= sz;
          if (inside) state.solid[(z * ny + y) * nx + x] = 1;
        }
      }
    }
    usedPrimitives += 1;
  }

  closeSolidMask3d(state, options.closeRadius ?? 2);

  let x0 = nx, x1 = -1, y0 = ny, y1 = -1, z0 = nz, z1 = -1, solidCells = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (!state.solid[(z * ny + y) * nx + x]) continue;
        solidCells += 1;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    }
  }
  const frontalCells = frontalProjection3d(state);
  return {
    solidCells,
    frontalCells,
    characteristicCells: equivalentDiameter3d(frontalCells),
    bbox: solidCells > 0 ? { x0, y0, z0, x1, y1, z1 } : null,
    cellSizeMm,
    extentsMm: [extentX, extentY, extentZ],
    latticeFromMm: { scale, originMm: [minX, midY, midZ], originLattice: [originX, ny / 2, nz / 2], angleOfAttackRad: theta },
    skipped,
    usedPrimitives,
  };
}

// ─── Voxelizer mesh: tam giác Three.js → lưới 3D ─────────────────
//
// Đây là đường "collision" thật: dòng chảy va vào ĐÚNG bề mặt tam giác mà
// Three.js render (lathe, wing planform, RoundedBox…), không phải hộp bao
// primitive. Lib này headless nên KHÔNG import three — nhận tam giác thô
// (9 float/tam giác, hệ CAD mm, y hướng lên); tầng app/test trích xuất bằng
// `geometry.toNonIndexed().getAttribute("position").array` (three core chạy
// được trong node, không cần DOM).
//
// Thuật toán: ray-parity theo cột. Mỗi cột (y,z) bắn một tia dọc +x, tính mọi
// giao điểm với các tam giác, sắp xếp rồi tô đặc giữa từng CẶP giao điểm.
// Yêu cầu mesh kín (watertight) — geometry three.js mặc định (sphere, box,
// cylinder có nắp, extrude) đều kín; cột có số giao điểm LẺ được đếm vào
// `openColumns` để phát hiện mesh hở thay vì im lặng tô sai.

export function voxelizeMeshMm(
  state: Lbm3dState,
  trianglesMm: Float32Array | number[],
  options: Voxelize3dOptions = {},
): Voxelize3dResult & { openColumns: number } {
  const { nx, ny, nz } = state;
  const crossTarget = Math.max(6, options.crossStreamCells ?? Math.max(12, Math.round(ny * 0.1)));
  const chordBudget = Math.max(8, options.chordCells ?? Math.round(nx * 0.55));
  const theta = ((options.angleOfAttackDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const vertexCount = Math.floor(trianglesMm.length / 3) * 3;
  const triangleCount = Math.floor(vertexCount / 9) * 1;
  if (triangleCount === 0) {
    return { solidCells: 0, frontalCells: 0, characteristicCells: 0, bbox: null, cellSizeMm: 1, extentsMm: [0, 0, 0], latticeFromMm: { scale: 1, originMm: [0, 0, 0], originLattice: [0, 0, 0], angleOfAttackRad: theta }, skipped: [], usedPrimitives: 0, openColumns: 0 };
  }

  // Xoay góc tấn (cùng quy ước với voxelizeScene) rồi tính bbox.
  const rx = new Float64Array(vertexCount / 3);
  const ry = new Float64Array(vertexCount / 3);
  const rz = new Float64Array(vertexCount / 3);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount / 3; v += 1) {
    const x = trianglesMm[v * 3], y = trianglesMm[v * 3 + 1], z = trianglesMm[v * 3 + 2];
    const xr = cos * x + sin * y;
    const yr = -sin * x + cos * y;
    rx[v] = xr; ry[v] = yr; rz[v] = z;
    if (xr < minX) minX = xr; if (xr > maxX) maxX = xr;
    if (yr < minY) minY = yr; if (yr > maxY) maxY = yr;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const extentX = Math.max(maxX - minX, 0.001);
  const extentY = Math.max(maxY - minY, 0.001);
  const extentZ = Math.max(maxZ - minZ, 0.001);
  const thinnest = Math.min(extentY, extentZ);
  const scale = Math.max(
    Math.min(crossTarget / thinnest, (ny * 0.75) / extentY, (nz * 0.75) / extentZ, chordBudget / extentX),
    4 / extentX,
  );
  const cellSizeMm = 1 / scale;
  const originX = 0.3 * nx - (extentX * scale) / 2;
  const midY = (minY + maxY) / 2, midZ = (minZ + maxZ) / 2;
  const toLatticeX = (v: number) => originX + (rx[v] - minX) * scale;
  const toLatticeY = (v: number) => ny / 2 + (ry[v] - midY) * scale;
  const toLatticeZ = (v: number) => nz / 2 + (rz[v] - midZ) * scale;

  // Giao điểm theo cột. Jitter vô tỷ tránh tia đâm trúng đúng cạnh tam giác.
  const JY = 0.2113, JZ = 0.1571;
  const crossings: number[][] = Array.from({ length: ny * nz }, () => []);
  for (let t = 0; t < triangleCount; t += 1) {
    const v0 = t * 3, v1 = v0 + 1, v2 = v0 + 2;
    const x0 = toLatticeX(v0), y0 = toLatticeY(v0), z0 = toLatticeZ(v0);
    const x1 = toLatticeX(v1), y1 = toLatticeY(v1), z1 = toLatticeZ(v1);
    const x2 = toLatticeX(v2), y2 = toLatticeY(v2), z2 = toLatticeZ(v2);
    const denom = (y1 - y0) * (z2 - z0) - (y2 - y0) * (z1 - z0);
    if (Math.abs(denom) < 1e-12) continue; // tam giác song song trục x — parity vẫn đúng nhờ mesh kín
    const yLo = Math.max(0, Math.floor(Math.min(y0, y1, y2) - JY));
    const yHi = Math.min(ny - 1, Math.ceil(Math.max(y0, y1, y2)));
    const zLo = Math.max(0, Math.floor(Math.min(z0, z1, z2) - JZ));
    const zHi = Math.min(nz - 1, Math.ceil(Math.max(z0, z1, z2)));
    for (let z = zLo; z <= zHi; z += 1) {
      const zc = z + JZ;
      for (let y = yLo; y <= yHi; y += 1) {
        const yc = y + JY;
        const u = ((yc - y0) * (z2 - z0) - (zc - z0) * (y2 - y0)) / denom;
        const v = ((y1 - y0) * (zc - z0) - (z1 - z0) * (yc - y0)) / denom;
        if (u < 0 || v < 0 || u + v > 1) continue;
        crossings[z * ny + y].push(x0 + u * (x1 - x0) + v * (x2 - x0));
      }
    }
  }

  let openColumns = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const list = crossings[z * ny + y];
      if (list.length === 0) continue;
      list.sort((a, b) => a - b);
      if (list.length % 2 === 1) { openColumns += 1; list.pop(); }
      for (let pair = 0; pair + 1 < list.length; pair += 2) {
        const xa = Math.max(0, Math.ceil(list[pair]));
        const xb = Math.min(nx - 1, Math.floor(list[pair + 1]));
        for (let x = xa; x <= xb; x += 1) state.solid[(z * ny + y) * nx + x] = 1;
      }
    }
  }

  // Mesh kín đã liền khối — mặc định KHÔNG đóng hình thái học (khác primitive path).
  closeSolidMask3d(state, options.closeRadius ?? 0);

  let bx0 = nx, bx1 = -1, by0 = ny, by1 = -1, bz0 = nz, bz1 = -1, solidCells = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (!state.solid[(z * ny + y) * nx + x]) continue;
        solidCells += 1;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
      }
    }
  }
  const frontalCells = frontalProjection3d(state);
  return {
    solidCells,
    frontalCells,
    characteristicCells: equivalentDiameter3d(frontalCells),
    bbox: solidCells > 0 ? { x0: bx0, y0: by0, z0: bz0, x1: bx1, y1: by1, z1: bz1 } : null,
    cellSizeMm,
    extentsMm: [extentX, extentY, extentZ],
    latticeFromMm: { scale, originMm: [minX, midY, midZ], originLattice: [originX, ny / 2, nz / 2], angleOfAttackRad: theta },
    skipped: [],
    usedPrimitives: triangleCount,
    openColumns,
  };
}

// ─── Chạy headless: warm-up → lấy mẫu lực ────────────────────────

export type Lbm3dSolveOptions = {
  nx?: number;
  ny?: number;
  nz?: number;
  latticeVelocity?: number;
  omega?: number;
  warmupSteps?: number;
  sampleSteps?: number;
  sampleEvery?: number;
  noise?: number;
  random?: () => number;
  smagorinsky?: number | null;
  build: (state: Lbm3dState) => void;
};

export type Lbm3dSolveResult = {
  state: Lbm3dState;
  /** Cd chuẩn theo diện tích cản thật. */
  cdMean: number;
  cdRms: number;
  /** Hệ số lực đứng (+y là LÊN — khác quy ước canvas 2D). */
  cyMean: number;
  cyRms: number;
  /** Hệ số lực ngang (+z). */
  czMean: number;
  czRms: number;
  frontalCells: number;
  characteristicCells: number;
  /** Khoảng cách ảnh tuần hoàn tính theo đường kính — thước đo "blockage" 3D. */
  latticeSpacingDiameters: number;
  maxSpeed: number;
  finite: boolean;
  steps: number;
};

export function solveLbm3d(options: Lbm3dSolveOptions): Lbm3dSolveResult {
  const nx = options.nx ?? 96;
  const ny = options.ny ?? 48;
  const nz = options.nz ?? 48;
  const latticeVelocity = options.latticeVelocity ?? 0.06;
  const omega = Math.min(1.995, Math.max(0.4, options.omega ?? 1.7));
  const warmupSteps = Math.max(0, options.warmupSteps ?? 800);
  const sampleSteps = Math.max(1, options.sampleSteps ?? 400);
  const sampleEvery = Math.max(1, options.sampleEvery ?? 5);
  const stepOptions: Step3dOptions = { smagorinsky: options.smagorinsky ?? null };

  const state = createLbm3d(nx, ny, nz);
  initLbm3d(state, latticeVelocity, options.noise ?? 0.01, options.random ?? seededRandom(7));
  options.build(state);

  const frontalCells = frontalProjection3d(state);
  const characteristicCells = equivalentDiameter3d(frontalCells);
  const denom = 0.5 * latticeVelocity * latticeVelocity * Math.max(frontalCells, 1);

  for (let i = 0; i < warmupSteps; i += 1) stepLbm3d(state, omega, latticeVelocity, stepOptions);

  const cd: number[] = [], cy: number[] = [], cz: number[] = [];
  for (let i = 0; i < sampleSteps; i += 1) {
    stepLbm3d(state, omega, latticeVelocity, stepOptions);
    if (i % sampleEvery !== 0) continue;
    const forces = momentumExchangeForces3d(state);
    cd.push(forces.fx / denom);
    cy.push(forces.fy / denom);
    cz.push(forces.fz / denom);
  }
  const mean = (a: number[]) => (a.length > 0 ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const rms = (a: number[], m: number) => (a.length > 0 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) : 0);
  const cdMean = mean(cd), cyMean = mean(cy), czMean = mean(cz);

  let maxSpeed = 0, finite = true;
  for (let i = 0; i < state.n; i += 1) {
    const speed = Math.sqrt(state.ux[i] ** 2 + state.uy[i] ** 2 + state.uz[i] ** 2);
    if (!Number.isFinite(speed)) { finite = false; continue; }
    if (speed > maxSpeed) maxSpeed = speed;
  }
  return {
    state,
    cdMean, cdRms: rms(cd, cdMean),
    cyMean, cyRms: rms(cy, cyMean),
    czMean, czRms: rms(cz, czMean),
    frontalCells,
    characteristicCells,
    latticeSpacingDiameters: characteristicCells > 0 ? Math.min(ny, nz) / characteristicCells : 0,
    maxSpeed,
    finite,
    steps: warmupSteps + sampleSteps,
  };
}

/** Cd quả cầu tự do theo Schiller–Naumann — mốc so sánh cho test và báo cáo. */
export function sphereDragSchillerNaumann(reynolds: number) {
  return (24 / reynolds) * (1 + 0.15 * Math.pow(reynolds, 0.687));
}
