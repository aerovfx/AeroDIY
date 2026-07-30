"use client";

/**
 * CfdGpuViewport — hầm gió 3D WebGPU quanh ĐÚNG chiếc máy người dùng đang thiết kế.
 *
 * Chuỗi dữ liệu: mesh three.js thật của CadViewport (`extractAssemblyTrianglesMm`)
 * → `voxelizeMeshMm` (ray-parity, bước 1) → solver GPU D3Q19 (kernel đã đối chiếu
 * bit với reference, bước 2) → tracer advect trên GPU + mặt cắt xoáy đọc theo dải.
 *
 * Kiến trúc vòng chạy: SIM là vòng promise thuần (không RAF) nên tiếp tục chạy
 * khi tab ẩn — bài học từ canvas 2D; chỉ phần RENDER bị bỏ qua khi `document.hidden`.
 * Mọi số liệu phơi qua `window.__cfd3d` để kiểm chứng headless.
 *
 * Giới hạn nói thẳng trên UI: lưới 160×96×96, Re mô phỏng thấp hơn bay thật,
 * biên ngang tuần hoàn (mảng ảnh ~2 sải cánh) — dùng để THẤY cấu trúc dòng 3D
 * và so phương án, không phải số chứng nhận.
 */

import { buildFlowAssembly, extractAssemblyTrianglesMm } from "@/app/components/CadViewport";
import type { ScenePrimitive } from "@/lib/cad-engine";
import {
  equivalentDiameter3d, frontalProjection3d, uniformEquilibrium3d,
  voxelizeMeshMm, type Lbm3dState, type Voxelize3dResult,
} from "@/lib/cfd-lbm3d";
import { createLbm3dGpu, type GpuDeviceLike, type Lbm3dGpu } from "@/lib/cfd-lbm3d-gpu";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const NX = 160, NY = 96, NZ = 96;
const TRACER_COUNT = 24000;
const SETTLE_STEPS = 600;
const PREWARM_STEPS = 500;

type NavigatorGpu = {
  gpu?: {
    requestAdapter(options?: { powerPreference?: string }): Promise<{
      limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
      requestDevice(desc: { requiredLimits: Record<string, number> }): Promise<GpuDeviceLike>;
    } | null>;
  };
};

type Cfd3dStats = {
  status: string;
  steps: number;
  mlups: number;
  cd: number | null;
  cl: number | null;
  diameterCells: number;
  solidCells: number;
  openColumns: number;
  error: string | null;
};

declare global {
  interface Window { __cfd3d?: Cfd3dStats }
}

type CfdGpuViewportProps = {
  scene: ScenePrimitive[];
  projectId: string;
  angleOfAttackDeg: number;
  velocityMs: number;
};

function makeMask(nx: number, ny: number, nz: number): Lbm3dState {
  return { nx, ny, nz, n: nx * ny * nz, solid: new Uint8Array(nx * ny * nz) } as unknown as Lbm3dState;
}

export function CfdGpuViewport({ scene, projectId, angleOfAttackDeg, velocityMs }: CfdGpuViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<Cfd3dStats>({ status: "đang khởi tạo WebGPU…", steps: 0, mlups: 0, cd: null, cl: null, diameterCells: 0, solidCells: 0, openColumns: 0, error: null });
  const [running, setRunning] = useState(true);
  const [reynolds, setReynolds] = useState(500);
  const [showSlice, setShowSlice] = useState(true);
  const [showTracers, setShowTracers] = useState(true);
  const [sliceMode, setSliceMode] = useState<"vorticity" | "speed">("vorticity");

  const runningRef = useRef(running);
  const reynoldsRef = useRef(reynolds);
  const showSliceRef = useRef(showSlice);
  const showTracersRef = useRef(showTracers);
  const sliceModeRef = useRef(sliceMode);
  useEffect(() => {
    runningRef.current = running;
    reynoldsRef.current = reynolds;
    showSliceRef.current = showSlice;
    showTracersRef.current = showTracers;
    sliceModeRef.current = sliceMode;
  }, [running, reynolds, showSlice, showTracers, sliceMode]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let sim: Lbm3dGpu | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;

    const publish = (patch: Partial<Cfd3dStats>) => {
      setStats((previous) => {
        const next = { ...previous, ...patch };
        if (typeof window !== "undefined") window.__cfd3d = next;
        return next;
      });
    };

    (async () => {
      // ─ WebGPU ─
      const gpu = (navigator as unknown as NavigatorGpu).gpu;
      if (!gpu) { publish({ status: "WebGPU không khả dụng — cần Chrome/Edge/Safari mới.", error: "no-webgpu" }); return; }
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) { publish({ status: "Không lấy được GPU adapter.", error: "no-adapter" }); return; }
      const device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 512 << 20),
          maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 << 20),
        },
      });
      if (disposed) return;

      // ─ Mesh thật → voxel ─
      publish({ status: "voxel hoá mesh three.js…" });
      const triangles = extractAssemblyTrianglesMm(scene);
      const mask = makeMask(NX, NY, NZ);
      const voxel: Voxelize3dResult & { openColumns: number } = voxelizeMeshMm(mask, triangles, {
        crossStreamCells: 13,
        angleOfAttackDeg,
      });
      const frontal = frontalProjection3d(mask);
      const diameter = Math.max(4, equivalentDiameter3d(frontal));
      publish({ diameterCells: Math.round(diameter), solidCells: voxel.solidCells, openColumns: voxel.openColumns });

      // ─ Solver GPU ─
      const inflow = 0.06;
      sim = createLbm3dGpu(device, NX, NY, NZ, { smagorinsky: 0.14 });
      sim.upload(uniformEquilibrium3d(NX * NY * NZ, inflow), mask.solid);
      const omegaFor = (re: number) => 1 / (3 * ((inflow * diameter) / Math.max(20, re)) + 0.5);
      sim.setParams(omegaFor(reynoldsRef.current), inflow);
      sim.initTracers(TRACER_COUNT);
      const denom = 0.5 * inflow * inflow * Math.max(frontal, 1);

      // ─ three.js scene (lattice units) ─
      const scene3 = new THREE.Scene();
      scene3.background = new THREE.Color(0x060a14);
      const camera = new THREE.PerspectiveCamera(40, 1, 1, 2000);
      camera.position.set(NX * 0.75, NY * 1.05, NZ * 1.7);
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      mount.appendChild(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(NX * 0.45, NY / 2, NZ / 2);
      controls.enableDamping = true;
      scene3.add(new THREE.AmbientLight(0xffffff, 1.6));
      const key = new THREE.DirectionalLight(0xffffff, 2.4);
      key.position.set(-NX, NY * 2, NZ);
      scene3.add(key);

      // Hộp miền
      const domainBox = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(NX, NY, NZ)),
        new THREE.LineBasicMaterial({ color: 0x3a3160, transparent: true, opacity: 0.9 }),
      );
      domainBox.position.set(NX / 2, NY / 2, NZ / 2);
      scene3.add(domainBox);

      // UAV thật, đặt vào hệ lattice qua latticeFromMm:
      //   lattice = originLattice + (Rz(−aoa)·p − originMm)·scale
      // ⇒ outer(scale + translate) chứa inner(rotation −aoa).
      const t = voxel.latticeFromMm;
      const inner = buildFlowAssembly(scene);
      inner.rotation.z = -t.angleOfAttackRad;
      // Cánh quạt quay chế độ bay (spinner + đĩa blur từ makePropeller). Nói
      // thẳng: đây là chuyển động THỊ GIÁC — voxel collision là bóng cánh đứng
      // yên, chưa phải actuator disk bơm động lượng (hướng mở đã ghi nhận).
      const propSpinners: Array<{ spinner: THREE.Object3D; direction: number }> = [];
      inner.children.forEach((object, index) => {
        if (!object.userData.propSpinner) return;
        const direction = Math.sign(object.position.x * object.position.z) || (index % 2 === 0 ? 1 : -1);
        object.userData.propBlurDisc.visible = true;
        propSpinners.push({ spinner: object.userData.propSpinner, direction });
      });
      const outer = new THREE.Group();
      outer.add(inner);
      outer.scale.setScalar(t.scale);
      outer.position.set(
        t.originLattice[0] - t.originMm[0] * t.scale,
        t.originLattice[1] - t.originMm[1] * t.scale,
        t.originLattice[2] - t.originMm[2] * t.scale,
      );
      scene3.add(outer);

      // Mặt cắt z giữa thân
      const sliceZ = Math.floor(NZ / 2);
      const sliceTexture = new THREE.DataTexture(new Uint8Array(NX * NY * 4), NX, NY, THREE.RGBAFormat);
      sliceTexture.needsUpdate = true;
      const slicePlane = new THREE.Mesh(
        new THREE.PlaneGeometry(NX, NY),
        new THREE.MeshBasicMaterial({ map: sliceTexture, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
      );
      slicePlane.position.set(NX / 2, NY / 2, sliceZ);
      scene3.add(slicePlane);

      // Tracer: 2 đỉnh/hạt (prev → pos), màu cầu vồng theo hue, mờ dần theo tuổi
      // bằng cách tối màu (additive blending nên tối = trong suốt).
      const tracerPositions = new Float32Array(TRACER_COUNT * 6);
      const tracerColors = new Float32Array(TRACER_COUNT * 6);
      const tracerGeometry = new THREE.BufferGeometry();
      tracerGeometry.setAttribute("position", new THREE.BufferAttribute(tracerPositions, 3));
      tracerGeometry.setAttribute("color", new THREE.BufferAttribute(tracerColors, 3));
      const tracerLines = new THREE.LineSegments(
        tracerGeometry,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      scene3.add(tracerLines);

      const resize = () => {
        if (!renderer) return;
        const width = mount.clientWidth || 800;
        const height = 420;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resize();
      window.addEventListener("resize", resize);

      // ─ Hâm nóng để khung đầu đã có dòng phát triển (bài học 2D) ─
      for (let warmed = 0; warmed < PREWARM_STEPS; warmed += 100) {
        if (disposed) return;
        await sim.steps(100);
        publish({ status: `hâm nóng dòng ${warmed + 100}/${PREWARM_STEPS}…` });
      }

      // ─ Vòng sim promise thuần ─
      let steps = PREWARM_STEPS;
      let tick = 0;
      let lastSpin = performance.now() / 1000;
      let lastPerf = performance.now();
      let stepWindow = 0;
      const hsl = new THREE.Color();
      const run = async () => {
        while (!disposed) {
          if (!runningRef.current) { await new Promise((r) => setTimeout(r, 120)); continue; }
          const stepsPerTick = 5;
          sim!.setParams(omegaFor(reynoldsRef.current), inflow);
          await sim!.steps(stepsPerTick);
          steps += stepsPerTick;
          stepWindow += stepsPerTick;
          tick += 1;

          if (showTracersRef.current) {
            await sim!.advectTracers(stepsPerTick, tick);
            const particles = await sim!.readTracers();
            for (let p = 0; p < TRACER_COUNT; p += 1) {
              const base = p * 8, v = p * 6;
              tracerPositions[v] = particles[base + 4]; tracerPositions[v + 1] = particles[base + 5]; tracerPositions[v + 2] = particles[base + 6];
              tracerPositions[v + 3] = particles[base]; tracerPositions[v + 4] = particles[base + 1]; tracerPositions[v + 5] = particles[base + 2];
              const fade = Math.max(0, 1 - particles[base + 3] / 620) * 0.85;
              hsl.setHSL(particles[base + 7], 1, 0.6);
              tracerColors[v] = hsl.r * fade; tracerColors[v + 1] = hsl.g * fade; tracerColors[v + 2] = hsl.b * fade;
              tracerColors[v + 3] = hsl.r * fade; tracerColors[v + 4] = hsl.g * fade; tracerColors[v + 5] = hsl.b * fade;
            }
            tracerGeometry.getAttribute("position").needsUpdate = true;
            tracerGeometry.getAttribute("color").needsUpdate = true;
          }
          tracerLines.visible = showTracersRef.current;

          if (showSliceRef.current && tick % 2 === 0) {
            const slice = await sim!.readVelocitySliceZ(sliceZ);
            const pixels = sliceTexture.image.data as Uint8Array;
            const mode = sliceModeRef.current;
            const speedMax = inflow * 1.6, vortMax = 0.02;
            for (let y = 0; y < NY; y += 1) {
              for (let x = 0; x < NX; x += 1) {
                const i = y * NX + x;
                let r = 0, g = 0, b = 0;
                if (mode === "speed") {
                  const ux = slice[i * 3], uy = slice[i * 3 + 1], uz = slice[i * 3 + 2];
                  let f = Math.sqrt(ux * ux + uy * uy + uz * uz) / speedMax;
                  f = f > 1 ? 1 : f;
                  if (f < 0.25) { const k = f * 4; r = 0; g = (k * 100) | 0; b = (120 + k * 135) | 0; }
                  else if (f < 0.5) { const k = (f - 0.25) * 4; r = 0; g = (100 + k * 155) | 0; b = (255 - k * 100) | 0; }
                  else if (f < 0.75) { const k = (f - 0.5) * 4; r = (k * 255) | 0; g = 255; b = (155 - k * 155) | 0; }
                  else { const k = (f - 0.75) * 4; r = 255; g = (255 - k * 255) | 0; b = 0; }
                } else {
                  // Xoáy trong mặt phẳng: ωz = ∂uy/∂x − ∂ux/∂y — cùng đại lượng canvas 2D vẽ.
                  let curl = 0;
                  if (x > 0 && x < NX - 1 && y > 0 && y < NY - 1) {
                    curl = (slice[(y * NX + x + 1) * 3 + 1] - slice[(y * NX + x - 1) * 3 + 1]) / 2
                      - (slice[((y + 1) * NX + x) * 3] - slice[((y - 1) * NX + x) * 3]) / 2;
                  }
                  let f = curl / vortMax;
                  f = f > 1 ? 1 : f < -1 ? -1 : f;
                  if (f > 0) { r = (255 * f) | 0; g = (60 * f) | 0; b = g; }
                  else { const k = -f; r = (60 * k) | 0; g = r; b = (255 * k) | 0; }
                }
                pixels[i * 4] = r; pixels[i * 4 + 1] = g; pixels[i * 4 + 2] = b;
                pixels[i * 4 + 3] = r + g + b > 24 ? 235 : 40;
              }
            }
            sliceTexture.needsUpdate = true;
          }
          slicePlane.visible = showSliceRef.current;

          if (tick % 10 === 0) {
            const forces = await sim!.readForces();
            const now = performance.now();
            const mlups = (stepWindow * NX * NY * NZ) / (now - lastPerf) / 1000;
            stepWindow = 0;
            lastPerf = now;
            publish({
              status: "đang chạy",
              steps,
              mlups: Math.round(mlups),
              // Quy ước 3D: y hướng LÊN ⇒ lực nâng là +fy (KHÁC canvas 2D).
              cd: steps >= SETTLE_STEPS ? forces.fx / denom : null,
              cl: steps >= SETTLE_STEPS ? forces.fy / denom : null,
            });
          }

          const spinNow = performance.now() / 1000;
          const spinDelta = Math.min(0.08, spinNow - lastSpin);
          lastSpin = spinNow;
          if (runningRef.current) for (const { spinner, direction } of propSpinners) spinner.rotation.y += direction * 52 * spinDelta;

          // Render khi hiện; NHƯNG vẫn vẽ định kỳ cả khi visibility báo hidden —
          // một số môi trường nhúng (pane preview) misreport document.hidden nên
          // nếu gate cứng thì canvas đen vĩnh viễn dù sim vẫn chạy.
          if ((!document.hidden || tick % 20 === 0) && renderer && controls) {
            controls.update();
            renderer.render(scene3, camera);
          }
        }
      };
      publish({ status: "đang chạy" });
      run();

      const cleanupExtras = () => window.removeEventListener("resize", resize);
      (mount as unknown as { __cleanup?: () => void }).__cleanup = cleanupExtras;
    })().catch((error) => publish({ status: "lỗi", error: String(error) }));

    return () => {
      disposed = true;
      (mount as unknown as { __cleanup?: () => void }).__cleanup?.();
      controls?.dispose();
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
      sim?.destroy();
    };
    // Dựng lại toàn bộ khi hình học/góc tấn đổi — runConfig chỉ đổi khi RUN SOLVER.
  }, [scene, angleOfAttackDeg, projectId]);

  return <section className="cfd3d-panel">
    <header>
      <span>HẦM GIÓ 3D · WEBGPU D3Q19 · MESH THREE.JS THẬT</span>
      <div className="cfd3d-live">
        <b>{stats.mlups > 0 ? `${stats.mlups} MLUPS` : ""}</b>
        <span>{stats.steps.toLocaleString()} bước</span>
        <span>D {stats.diameterCells} ô · {stats.solidCells.toLocaleString()} voxel{stats.openColumns > 0 ? ` · ${stats.openColumns} cột mesh hở` : ""}</span>
        <span>{stats.status}</span>
      </div>
    </header>
    <div className="cfd3d-toolbar">
      <button className={running ? "active" : ""} onClick={() => setRunning((v) => !v)}>{running ? "❚❚ DỪNG" : "▶ CHẠY"}</button>
      <label>Re <b>{reynolds}</b><input type="range" min="100" max="3000" step="50" value={reynolds} onChange={(e) => setReynolds(Number(e.target.value))} /></label>
      <button className={showTracers ? "active" : ""} onClick={() => setShowTracers((v) => !v)}>≋ TRACER</button>
      <button className={showSlice ? "active" : ""} onClick={() => setShowSlice((v) => !v)}>▤ MẶT CẮT</button>
      <button className={sliceMode === "vorticity" ? "active" : ""} onClick={() => setSliceMode("vorticity")}>XOÁY</button>
      <button className={sliceMode === "speed" ? "active" : ""} onClick={() => setSliceMode("speed")}>VẬN TỐC</button>
      {stats.cd !== null && <span className="cfd3d-forces">Cd <b>{stats.cd.toFixed(3)}</b> · Cl <b>{(stats.cl ?? 0).toFixed(3)}</b></span>}
    </div>
    <div ref={mountRef} className="cfd3d-stage" />
    <p className="cfd3d-note">
      Dòng chảy va vào đúng mesh three.js của <b>{projectId.toUpperCase()}</b> (ray-parity voxel, AOA {angleOfAttackDeg}°).
      Kernel WGSL đã đối chiếu từng giá trị với reference JS (max|Δf| ~ 3e-7). Lưới {NX}×{NY}×{NZ}, Re mô phỏng thấp hơn
      bay thật ({velocityMs} m/s), biên ngang tuần hoàn — dùng để thấy cấu trúc dòng 3D và so phương án, không phải số chứng nhận.
    </p>
  </section>;
}
