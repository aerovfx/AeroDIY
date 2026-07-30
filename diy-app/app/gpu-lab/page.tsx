"use client";

/**
 * GPU Lab — bước 2 của lộ trình 3D: đối chiếu kernel WGSL với reference JS và
 * chạy mốc quả cầu ở khoảng cách ảnh ~9D (nơi độ nhạy hình dáng quay lại —
 * ở ~5D của lưới JS, đĩa phẳng và quả cầu cho Cd trùng nhau).
 *
 * Trang import ĐÚNG các module lib đã dùng cho test node — không nhân bản code
 * như spike thăm dò. Mọi runner đều promise thuần (không RAF) để chạy được cả
 * khi tab ẩn, và phơi tiến độ qua `window.__gpuLab` cho kiểm chứng headless.
 */

import {
  createLbm3d, initLbm3d, stepLbm3d, momentumExchangeForces3d,
  presetSphere3d, presetEllipsoid3d, frontalProjection3d, equivalentDiameter3d,
  uniformEquilibrium3d, sphereDragSchillerNaumann, type Lbm3dState,
} from "@/lib/cfd-lbm3d";
import { createLbm3dGpu, type GpuDeviceLike } from "@/lib/cfd-lbm3d-gpu";
import { seededRandom } from "@/lib/cfd-lbm";
import { useEffect, useRef, useState } from "react";

type NavigatorGpu = {
  gpu?: {
    requestAdapter(options?: { powerPreference?: string }): Promise<{
      info?: { vendor?: string; architecture?: string; description?: string };
      limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
      requestDevice(desc: { requiredLimits: Record<string, number> }): Promise<GpuDeviceLike>;
    } | null>;
  };
};

type LabState = {
  phase: string;
  progress: string;
  verify: { maxDiffBgk: number; maxDiffLes: number; forceRelDiff: number; pass: boolean } | null;
  bench: Array<{ grid: string; cells: number; msStep: number; mlups: number }>;
  sphere: Array<{ label: string; reynolds: number; cd: number; cdRms: number; book: number; inflation: number; spacingD: number }>;
  shape: { sphereCd: number; diskCd: number; ratio: number } | null;
  shapeFine: { sphereCd: number; diskCd: number; ratio: number; diameter: number; spacingD: number } | null;
  error: string | null;
};

declare global {
  interface Window {
    __gpuLab?: LabState & { run?: (what: string) => Promise<void> };
  }
}

/** Mặt nạ solid gọn cho lưới lớn — đủ bề mặt cho preset/frontal, không bảng streaming. */
function makeMask(nx: number, ny: number, nz: number): Lbm3dState {
  return { nx, ny, nz, n: nx * ny * nz, solid: new Uint8Array(nx * ny * nz) } as unknown as Lbm3dState;
}

export default function GpuLabPage() {
  const [lab, setLab] = useState<LabState>({ phase: "init", progress: "", verify: null, bench: [], sphere: [], shape: null, shapeFine: null, error: null });
  const [adapterLine, setAdapterLine] = useState("đang kiểm tra WebGPU…");
  const deviceRef = useRef<GpuDeviceLike | null>(null);
  const labRef = useRef(lab);

  const update = (patch: Partial<LabState>) => {
    labRef.current = { ...labRef.current, ...patch };
    setLab(labRef.current);
    if (typeof window !== "undefined") window.__gpuLab = { ...labRef.current, run };
  };

  useEffect(() => {
    (async () => {
      const gpu = (navigator as unknown as NavigatorGpu).gpu;
      if (!gpu) { setAdapterLine("WebGPU không khả dụng trong trình duyệt này."); update({ phase: "no-webgpu" }); return; }
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) { setAdapterLine("Không lấy được adapter."); update({ phase: "no-webgpu" }); return; }
      const info = adapter.info ?? {};
      const wantBind = Math.min(adapter.limits.maxStorageBufferBindingSize, 1024 << 20);
      const wantBuf = Math.min(adapter.limits.maxBufferSize, 1024 << 20);
      deviceRef.current = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: wantBind, maxBufferSize: wantBuf } });
      setAdapterLine(`${[info.vendor, info.architecture].filter(Boolean).join(" · ") || "GPU"} · buffer ${(wantBind / 1048576).toFixed(0)} MB`);
      update({ phase: "ready" });
    })().catch((error) => update({ phase: "error", error: String(error) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 1. Đối chiếu GPU vs JS reference ───
  async function runVerify() {
    const device = deviceRef.current!;
    const nx = 48, ny = 32, nz = 32, inflow = 0.06, omega = 1.85, steps = 30;
    const compare = async (smagorinsky: number | null) => {
      const js = createLbm3d(nx, ny, nz);
      initLbm3d(js, inflow, 0.01, seededRandom(7));
      presetSphere3d(js, 14, 16, 16, 5);
      const f0 = Float32Array.from(js.f);
      const gpuSim = createLbm3dGpu(device, nx, ny, nz, { smagorinsky });
      gpuSim.upload(f0, js.solid);
      gpuSim.setParams(omega, inflow);
      for (let i = 0; i < steps; i += 1) stepLbm3d(js, omega, inflow, { smagorinsky });
      await gpuSim.steps(steps);
      const gpuF = await gpuSim.readF();
      let maxDiff = 0;
      for (let i = 0; i < gpuF.length; i += 1) {
        const d = Math.abs(gpuF[i] - js.f[i]);
        if (d > maxDiff) maxDiff = d;
      }
      const jsForces = momentumExchangeForces3d(js);
      const gpuForces = await gpuSim.readForces();
      const forceRelDiff = Math.abs(gpuForces.fx - jsForces.fx) / Math.max(Math.abs(jsForces.fx), 1e-9);
      gpuSim.destroy();
      return { maxDiff, forceRelDiff };
    };
    update({ phase: "verify", progress: "BGK 30 bước…" });
    const bgk = await compare(null);
    update({ progress: "LES 30 bước…" });
    const les = await compare(0.14);
    const pass = bgk.maxDiff < 1e-5 && les.maxDiff < 1e-5 && bgk.forceRelDiff < 1e-3;
    update({ phase: "ready", progress: "", verify: { maxDiffBgk: bgk.maxDiff, maxDiffLes: les.maxDiff, forceRelDiff: bgk.forceRelDiff, pass } });
  }

  // ─── 2. Benchmark hiệu năng kernel thật (BGK + LES như cấu hình sản phẩm) ───
  async function runBench() {
    const device = deviceRef.current!;
    const grids: Array<[number, number, number]> = [[96, 64, 64], [128, 96, 96], [192, 128, 128]];
    const rows: LabState["bench"] = [];
    for (const [nx, ny, nz] of grids) {
      update({ phase: "bench", progress: `đo ${nx}×${ny}×${nz}…` });
      const n = nx * ny * nz;
      const mask = makeMask(nx, ny, nz);
      presetSphere3d(mask, nx * 0.3, ny / 2, nz / 2, Math.round(ny / 9));
      const sim = createLbm3dGpu(device, nx, ny, nz, { smagorinsky: 0.14 });
      sim.upload(uniformEquilibrium3d(n, 0.06), mask.solid);
      sim.setParams(1.9, 0.06);
      await sim.steps(10);
      let ms = 0, count = 0;
      while (ms < 700 && count < 3000) {
        const t0 = performance.now();
        await sim.steps(50);
        ms += performance.now() - t0;
        count += 50;
      }
      const msStep = ms / count;
      rows.push({ grid: `${nx}×${ny}×${nz}`, cells: n, msStep, mlups: n / msStep / 1000 });
      sim.destroy();
      update({ bench: [...rows] });
    }
    update({ phase: "ready", progress: "" });
  }

  // ─── Chạy một ca quả cầu/đĩa trên lưới lớn, trả Cd trung bình ───
  async function measureCase(label: string, reynolds: number, smagorinsky: number | null, build: (mask: Lbm3dState) => void, grid: [number, number, number] = [192, 128, 128]) {
    const device = deviceRef.current!;
    const [nx, ny, nz] = grid;
    const inflow = 0.06;
    const mask = makeMask(nx, ny, nz);
    build(mask);
    const frontal = frontalProjection3d(mask);
    const diameter = equivalentDiameter3d(frontal);
    const omega = 1 / (3 * ((inflow * diameter) / reynolds) + 0.5);
    const sim = createLbm3dGpu(device, nx, ny, nz, { smagorinsky });
    sim.upload(uniformEquilibrium3d(nx * ny * nz, inflow), mask.solid);
    sim.setParams(omega, inflow);
    const denom = 0.5 * inflow * inflow * frontal;
    const warmBatches = 10, warmPerBatch = 250;
    for (let b = 0; b < warmBatches; b += 1) {
      await sim.steps(warmPerBatch);
      update({ progress: `${label}: warm-up ${(b + 1) * warmPerBatch}/${warmBatches * warmPerBatch}` });
    }
    const cds: number[] = [];
    for (let sample = 0; sample < 50; sample += 1) {
      await sim.steps(25);
      const forces = await sim.readForces();
      cds.push(forces.fx / denom);
      if (sample % 10 === 9) update({ progress: `${label}: mẫu ${sample + 1}/50` });
    }
    sim.destroy();
    const mean = cds.reduce((s, v) => s + v, 0) / cds.length;
    const rms = Math.sqrt(cds.reduce((s, v) => s + (v - mean) ** 2, 0) / cds.length);
    return { cd: mean, cdRms: rms, diameter, spacingD: Math.min(ny, nz) / diameter };
  }

  // ─── 3. Mốc quả cầu @ ~9D ───
  async function runSphere() {
    update({ phase: "sphere", sphere: [] });
    const rows: LabState["sphere"] = [];
    for (const [reynolds, smagorinsky] of [[100, null], [300, 0.14]] as Array<[number, number | null]>) {
      const r = await measureCase(`quả cầu Re=${reynolds}`, reynolds, smagorinsky, (mask) => presetSphere3d(mask, 58, 64, 64, 7));
      const book = sphereDragSchillerNaumann(reynolds);
      rows.push({ label: `Quả cầu Re=${reynolds}${smagorinsky ? " (LES)" : ""}`, reynolds, cd: r.cd, cdRms: r.cdRms, book, inflation: r.cd / book, spacingD: r.spacingD });
      update({ sphere: [...rows] });
    }
    update({ phase: "ready", progress: "" });
  }

  // ─── 4. Đĩa vs cầu @ ~9D — độ nhạy hình dáng phải quay lại ───
  async function runShape() {
    update({ phase: "shape", shape: null });
    const sphere = await measureCase("cầu Re=150", 150, 0.14, (mask) => presetSphere3d(mask, 58, 64, 64, 7));
    const disk = await measureCase("đĩa Re=150", 150, 0.14, (mask) => presetEllipsoid3d(mask, 58, 64, 64, 2.2, 7, 7));
    update({ phase: "ready", progress: "", shape: { sphereCd: sphere.cd, diskCd: disk.cd, ratio: disk.cd / sphere.cd } });
  }

  // ─ 5. Đĩa vs cầu ở D=20 (lưới 256×160×160, khoảng ảnh 8D, mép đĩa ~6.3 ô) ─
  //
  // Bài @9D cho ×1.08 — khoảng ảnh đủ nhưng mép đĩa chỉ ~4 ô. Ca này tăng phân
  // giải D 14→20 GIỮ NGUYÊN tỷ lệ hình học (a/r = 2.2/7) để tách riêng biến
  // "phân giải" khỏi biến "hình dáng". 2×498 MB buffer — vừa giới hạn 1 GB.
  async function runShapeFine() {
    update({ phase: "shapeFine", shapeFine: null });
    const grid: [number, number, number] = [256, 160, 160];
    const radius = 10;
    const sphere = await measureCase("cầu D=20 Re=150", 150, 0.14, (mask) => presetSphere3d(mask, 76, 80, 80, radius), grid);
    const disk = await measureCase("đĩa D=20 Re=150", 150, 0.14, (mask) => presetEllipsoid3d(mask, 76, 80, 80, radius * (2.2 / 7), radius, radius), grid);
    update({ phase: "ready", progress: "", shapeFine: { sphereCd: sphere.cd, diskCd: disk.cd, ratio: disk.cd / sphere.cd, diameter: sphere.diameter, spacingD: sphere.spacingD } });
  }

  async function run(what: string) {
    try {
      if (what === "verify") await runVerify();
      else if (what === "bench") await runBench();
      else if (what === "sphere") await runSphere();
      else if (what === "shape") await runShape();
      else if (what === "shapeFine") await runShapeFine();
    } catch (error) {
      update({ phase: "error", error: String(error) });
    }
  }

  useEffect(() => {
    if (typeof window !== "undefined") window.__gpuLab = { ...labRef.current, run };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = !["ready", "init", "no-webgpu", "error"].includes(lab.phase);
  const panel: React.CSSProperties = { border: "1px solid #2a2344", background: "#161228", borderRadius: 6, padding: "12px 16px", margin: "12px 0" };
  const button: React.CSSProperties = { background: "#9b4de0", border: 0, borderRadius: 4, color: "#fff", fontWeight: 700, padding: "8px 16px", marginRight: 8, cursor: "pointer", opacity: busy ? 0.4 : 1 };

  return <div style={{ minHeight: "100vh", background: "#0d0a1a", color: "#e8e4f4", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, padding: 24 }}>
    <h1 style={{ fontSize: 16, letterSpacing: "0.08em", color: "#dda9ec" }}>GPU LAB · LBM D3Q19 — BƯỚC 2
      <small style={{ display: "block", color: "#8b84a8", fontWeight: 400, fontSize: 11 }}>
        Kernel WGSL sinh từ hằng số reference · đối chiếu từng giá trị với JS · mốc quả cầu ở khoảng cách ảnh ~9D
      </small>
    </h1>
    <div style={panel}><b style={{ color: "#dda9ec" }}>ADAPTER</b> · {adapterLine} · <span style={{ color: "#8b84a8" }}>{lab.phase}{lab.progress ? ` — ${lab.progress}` : ""}</span></div>

    <div style={panel}>
      <button style={button} disabled={busy} onClick={() => run("verify")}>1 · ĐỐI CHIẾU GPU vs JS</button>
      <button style={button} disabled={busy} onClick={() => run("bench")}>2 · BENCHMARK</button>
      <button style={button} disabled={busy} onClick={() => run("sphere")}>3 · QUẢ CẦU @9D</button>
      <button style={button} disabled={busy} onClick={() => run("shape")}>4 · ĐĨA vs CẦU @9D</button>
      <button style={button} disabled={busy} onClick={() => run("shapeFine")}>5 · ĐĨA vs CẦU @D=20</button>
    </div>

    {lab.verify && <div style={panel}>
      <b style={{ color: lab.verify.pass ? "#5ad8a0" : "#e07a7a" }}>{lab.verify.pass ? "KHỚP REFERENCE" : "LỆCH — KERNEL SAI"}</b>
      {" "}· max|Δf| BGK = {lab.verify.maxDiffBgk.toExponential(2)} · LES = {lab.verify.maxDiffLes.toExponential(2)} · lệch lực = {(lab.verify.forceRelDiff * 100).toExponential(2)}%
    </div>}

    {lab.bench.length > 0 && <div style={panel}>
      {lab.bench.map((row) => <div key={row.grid}>{row.grid} = {(row.cells / 1e6).toFixed(2)}M ô: <b>{row.msStep.toFixed(2)} ms/bước · {row.mlups.toFixed(0)} MLUPS</b> (kèm LES)</div>)}
    </div>}

    {lab.sphere.length > 0 && <div style={panel}>
      {lab.sphere.map((row) => <div key={row.label}>{row.label}: <b>Cd = {row.cd.toFixed(3)} ± {row.cdRms.toFixed(3)}</b> · sách {row.book.toFixed(3)} · lạm phát ×{row.inflation.toFixed(2)} · khoảng ảnh {row.spacingD.toFixed(1)}D</div>)}
    </div>}

    {lab.shape && <div style={panel}>
      Đĩa Cd = <b>{lab.shape.diskCd.toFixed(3)}</b> vs cầu Cd = <b>{lab.shape.sphereCd.toFixed(3)}</b> → tỷ lệ <b style={{ color: lab.shape.ratio > 1.15 ? "#5ad8a0" : "#e0b96a" }}>×{lab.shape.ratio.toFixed(2)}</b>
      <div style={{ color: "#8b84a8", fontSize: 11 }}>Ở khoảng ảnh ~5D (lưới JS) hai hình cho Cd trùng nhau — tỷ lệ &gt; 1.15 ở đây chứng minh 9D đủ giãn để so sánh hình dáng.</div>
    </div>}

    {lab.shapeFine && <div style={panel}>
      D=20 (mép đĩa ~6.3 ô, khoảng ảnh {lab.shapeFine.spacingD.toFixed(1)}D): đĩa Cd = <b>{lab.shapeFine.diskCd.toFixed(3)}</b> vs cầu Cd = <b>{lab.shapeFine.sphereCd.toFixed(3)}</b> → tỷ lệ <b style={{ color: lab.shapeFine.ratio > 1.15 ? "#5ad8a0" : "#e0b96a" }}>×{lab.shapeFine.ratio.toFixed(2)}</b>
      <div style={{ color: "#8b84a8", fontSize: 11 }}>Chuỗi hội tụ độ nhạy hình dáng: ×1.00 (5D, D=10) → ×1.08 (9.4D, D=14) → ca này.</div>
    </div>}

    {lab.error && <div style={{ ...panel, color: "#e07a7a" }}>LỖI: {lab.error}</div>}
  </div>;
}
