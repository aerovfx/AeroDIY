"use client";

/**
 * CfdLbmCanvas — hầm gió số 2D chạy trực tiếp trong trình duyệt.
 *
 * Cổng CFD-LITE chỉ cho con số ước lượng; panel này chạy solver Lattice Boltzmann
 * thật (`lib/cfd-lbm.ts`) trên bóng chiếu hình học CAD, nên NHÌN THẤY được wake,
 * điểm tách dòng và xoáy Karman.
 *
 * Tham số mặc định dưới đây không phải phỏng đoán — chúng được tinh chỉnh trên một
 * harness render headless (vì requestAnimationFrame bị treo khi cửa sổ trình duyệt
 * ẩn, không tinh chỉnh được qua ảnh chụp) rồi mới port vào đây:
 *
 *   - MRT + Smagorinsky LES: BGK nổ ở Re≈3000, MRT trụ được tới Re≈12000.
 *     Giá phải trả: MRT +21.8% thời gian/bước so BGK, thêm LES thành +48.3%.
 *   - Kích xoáy 300 bước đầu: ClRms sau 500 bước tăng 0.021 → 0.251 (×12), nên
 *     xoáy cuộn rõ sau ~2-3 giây thay vì hơn một phút.
 *   - closeRadius 3 khi rasterize: bóng dự án từ 4 khối rời thành 1 khối liền.
 *   - Trường khói D2Q5 TẮT sẵn: thời gian quá cảnh (~3200 bước) dài hơn cửa sổ
 *     người dùng thường xem nên khói tích tụ thành sương mù che mất trường xoáy.
 *     Nó hữu ích như lớp xem pha trộn, không phải lớp chính.
 */

import { buildCadProject, type ScenePrimitive } from "@/lib/cad-engine";
import { buildCargoDroneCadProject } from "@/lib/cargo-drone-data";
import { buildDeliveryDroneCadProject } from "@/lib/delivery-drone-data";
import { buildEnduranceCadProject } from "@/lib/endurance-drone-data";
import { buildFpvRacerCadProject } from "@/lib/fpv-racer-data";
import { buildLongRangeCadProject } from "@/lib/long-range-uav-data";
import { buildMotherUavCadProject } from "@/lib/mother-uav-data";
import { buildVtolCadProject } from "@/lib/vtol-drone-data";
import {
  applyTransverseImpulse,
  clearObstacles,
  computeLbmReport,
  createLbm,
  createScalarField,
  initLbm,
  LBM_SHAPES,
  lbmReportToMarkdown,
  momentumExchangeForces,
  paintBrush,
  rasterizeScene,
  resetScalarField,
  scalarOmega,
  sheddingTriggerRegion,
  stepLbm,
  stepScalar,
  type CollisionModel,
  type LbmColorMode,
  type LbmPlane,
  type LbmReport,
  type LbmShapeId,
  type LbmState,
  type ScalarField,
} from "@/lib/cfd-lbm";
import { useCallback, useEffect, useRef, useState } from "react";

const NX = 300;
const NY = 140;
const CANVAS_W = 1200;
const CANVAS_H = Math.round(CANVAS_W * (NY / NX));
const BACKDROP = "#03050e";
const SOLID_COLOR = 0xff503c3c;
/** Số bước tối thiểu để dòng phát triển trước khi công bố Cd/Cl. */
const SETTLE_STEPS = 600;
/** Số bước bơm xung kích xoáy sau mỗi lần đặt lại dòng. */
const TRIGGER_STEPS = 300;
const TRIGGER_AMPLITUDE = 0.004;
/**
 * Số bước hâm nóng đồng bộ khi dựng vật cản. 700 chứ không phải 400: dải mực cần
 * ~620 bước tuổi để băng hết miền, nên hâm nóng phải dài hơn ngần đó thì khung vẽ
 * ĐẦU TIÊN mới có sẵn dải mực đầy miền thay vì vài vệt ở inlet. Tốn ~0.9 s một lần
 * khi dựng lại vật cản.
 */
const PREWARM_STEPS = 700;
/** Nhịp "frame ảo" khi hâm nóng — khớp stepsPerFrame điển hình của vòng RAF. */
const PREWARM_STEPS_PER_FRAME = 5;
const DYE_STREAMS = 12;
const DYE_MAX_AGE = 620;
/** Số bucket màu/tuổi khi gộp segment — quyết định số lệnh stroke mỗi frame. */
const DYE_HUE_BUCKETS = 12;
const DYE_AGE_BANDS = 4;
/**
 * Mực được đẩy nhanh hơn dòng thật để dải kịp băng miền trong ~2 giây (giữ đúng
 * quy ước của bản Aeroedu). Tuổi cũng tính bằng bước sim, nên tuổi tối đa 620 ứng
 * với đúng quãng đường một dải đi hết chiều dài miền.
 */
const DYE_SPEED_SCALE = 5;
/** Dải hue brand: indigo → tím → hồng của logo AeroVFX. */
const BRAND_HUE_START = 250;
const BRAND_HUE_SPAN = 80;

type ObstacleSource =
  | { kind: "project"; plane: LbmPlane }
  | { kind: "shape"; id: LbmShapeId }
  | { kind: "uav"; id: UavSectionId }
  | { kind: "blank" };

// ── Mặt cắt các loại UAV cụ thể ──
//
// Không vẽ silhouette tay: mỗi mặt cắt là bóng chiếu mặt cạnh của ĐÚNG hình học
// CAD mà project template tương ứng dựng ra (cùng đường rasterize + đóng hình
// thái học với dự án đang mở). Nhờ đó cái người dùng so sánh trong hầm gió là
// hình dáng thật của từng archetype, không phải hình minh hoạ.
type UavSectionId = "mini" | "longrange" | "vtol" | "fpv" | "delivery" | "cargo" | "endurance" | "mother";

type UavSectionDef = {
  id: UavSectionId;
  label: string;
  icon: string;
  desc: string;
  build: () => ScenePrimitive[];
};

const UAV_SECTIONS: UavSectionDef[] = [
  { id: "mini", label: "Quad mini", icon: "✛", desc: "Budget Mini UAV — khung quad 230 mm", build: () => buildCadProject().scene },
  { id: "fpv", label: "FPV racer", icon: "🏁", desc: "Khung racer nghiêng, tối ưu tốc độ", build: () => buildFpvRacerCadProject().scene },
  { id: "longrange", label: "Cánh bằng", icon: "🛩", desc: "Long Range UAV — thân + cánh liền", build: () => buildLongRangeCadProject().scene },
  { id: "vtol", label: "VTOL quadplane", icon: "🛫", desc: "Cánh bằng + 4 rotor nâng", build: () => buildVtolCadProject().scene },
  { id: "endurance", label: "Bay bền", icon: "🔋", desc: "Endurance drone — sải cánh lớn", build: () => buildEnduranceCadProject().scene },
  { id: "delivery", label: "Giao hàng", icon: "📦", desc: "Delivery drone — khoang hàng dưới bụng", build: () => buildDeliveryDroneCadProject().scene },
  { id: "cargo", label: "Chở hàng", icon: "🚚", desc: "Cargo drone tải nặng", build: () => buildCargoDroneCadProject().scene },
  { id: "mother", label: "UAV mẹ", icon: "🛰", desc: "Carrier 6 dock micro-UAV", build: () => buildMotherUavCadProject().scene },
];

/** Scene của mỗi mặt cắt chỉ dựng một lần rồi dùng lại. */
const uavSceneCache = new Map<UavSectionId, ScenePrimitive[]>();

function uavSectionScene(id: UavSectionId): ScenePrimitive[] {
  let cached = uavSceneCache.get(id);
  if (!cached) {
    cached = UAV_SECTIONS.find((section) => section.id === id)!.build();
    uavSceneCache.set(id, cached);
  }
  return cached;
}
type DyePalette = "spectrum" | "brand";
type DyeParticle = { x: number; y: number; prevX: number; prevY: number; age: number; hue: number; alive: boolean };

type CfdLbmCanvasProps = {
  scene: ScenePrimitive[];
  projectId: string;
  angleOfAttackDeg: number;
  velocityMs: number;
};

export function CfdLbmCanvas({ scene, projectId, angleOfAttackDeg, velocityMs }: CfdLbmCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<LbmState | null>(null);
  const scalarRef = useRef<ScalarField | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const offCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dyeRef = useRef<DyeParticle[]>([]);
  const dyeHueRef = useRef(0);
  const drawingRef = useRef(false);
  const stepCounterRef = useRef(0);
  const forceHistoryRef = useRef<Array<{ cd: number; cl: number }>>([]);
  const characteristicCellsRef = useRef(0);
  const triggerRegionRef = useRef<{ x0: number; x1: number; y0: number; y1: number } | null>(null);

  const [running, setRunning] = useState(true);
  const [inflowU, setInflowU] = useState(0.095);
  const [reynolds, setReynolds] = useState(400);
  const [collision, setCollision] = useState<CollisionModel>("mrt");
  const [les, setLes] = useState(true);
  const [colorMode, setColorMode] = useState<LbmColorMode>("vorticity");
  const [showDye, setShowDye] = useState(true);
  const [dyePalette, setDyePalette] = useState<DyePalette>("spectrum");
  const [showSmoke, setShowSmoke] = useState(false);
  const [showVectors, setShowVectors] = useState(false);
  const [fieldAlpha, setFieldAlpha] = useState(0.42);
  const [brushMode, setBrushMode] = useState<"off" | "add" | "erase">("off");
  const [source, setSource] = useState<ObstacleSource>({ kind: "project", plane: "side" });
  const [fps, setFps] = useState(0);
  const [step, setStep] = useState(0);
  const [live, setLive] = useState<{ cd: number; cl: number; cdMean: number; clRms: number } | null>(null);
  const [report, setReport] = useState<LbmReport | null>(null);
  const [copied, setCopied] = useState(false);
  /** Bề dày chắn dòng để hiển thị — state chứ không đọc ref trong lúc render. */
  const [characteristicCells, setCharacteristicCells] = useState(0);

  // Ref phản chiếu state để vòng lặp RAF đọc giá trị mới nhất mà không phải khởi
  // động lại chính nó mỗi lần người dùng kéo slider.
  const runningRef = useRef(running);
  const inflowRef = useRef(inflowU);
  const reynoldsRef = useRef(reynolds);
  const collisionRef = useRef(collision);
  const lesRef = useRef(les);
  const colorModeRef = useRef(colorMode);
  const dyeFlagRef = useRef(showDye);
  const paletteRef = useRef(dyePalette);
  const smokeRef = useRef(showSmoke);
  const vectorsRef = useRef(showVectors);
  const fieldAlphaRef = useRef(fieldAlpha);
  // Đồng bộ trong effect, KHÔNG gán trực tiếp trong thân component: ghi ref khi
  // render là anti-pattern React (eslint react-hooks/refs) và có thể khiến UI đọc
  // giá trị cũ khi React render lại mà không commit.
  useEffect(() => {
    runningRef.current = running;
    inflowRef.current = inflowU;
    reynoldsRef.current = reynolds;
    collisionRef.current = collision;
    lesRef.current = les;
    colorModeRef.current = colorMode;
    dyeFlagRef.current = showDye;
    paletteRef.current = dyePalette;
    smokeRef.current = showSmoke;
    vectorsRef.current = showVectors;
    fieldAlphaRef.current = fieldAlpha;
  }, [running, inflowU, reynolds, collision, les, colorMode, showDye, dyePalette, showSmoke, showVectors, fieldAlpha]);

  /**
   * Một "frame" mực: phun 12 hạt ở inlet rồi advect toàn bộ theo `spf` bước sim.
   * Dùng chung cho vòng RAF (spf = stepsPerFrame) và hâm nóng (spf = 5) để hai
   * đường đi cho ra đúng cùng một chuyển động — trước đây harness và canvas lệch
   * nhau chính vì tồn tại hai bản advect khác nhịp.
   */
  const advectDyeFrame = useCallback((state: LbmState, spf: number) => {
    const spectrum = paletteRef.current === "spectrum";
    for (let stream = 0; stream < DYE_STREAMS; stream += 1) {
      const y = (NY * (stream + 0.5)) / DYE_STREAMS;
      const hue = spectrum
        ? (dyeHueRef.current + stream * (360 / DYE_STREAMS)) % 360
        : BRAND_HUE_START + ((dyeHueRef.current + stream * 7) % BRAND_HUE_SPAN);
      dyeRef.current.push({ x: 1.5, y, prevX: 1.5, prevY: y, age: 0, hue, alive: true });
    }
    dyeHueRef.current = (dyeHueRef.current + 3) % 360;
    for (const particle of dyeRef.current) {
      if (!particle.alive) continue;
      particle.prevX = particle.x;
      particle.prevY = particle.y;
      const ix = Math.floor(particle.x);
      const iy = Math.floor(particle.y);
      if (ix < 0 || ix >= NX - 1 || iy < 0 || iy >= NY - 1 || state.solid[iy * NX + ix]) { particle.alive = false; continue; }
      const fx2 = particle.x - ix;
      const fy2 = particle.y - iy;
      const i00 = iy * NX + ix, i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1;
      const vx = state.ux[i00] * (1 - fx2) * (1 - fy2) + state.ux[i10] * fx2 * (1 - fy2) + state.ux[i01] * (1 - fx2) * fy2 + state.ux[i11] * fx2 * fy2;
      const vy = state.uy[i00] * (1 - fx2) * (1 - fy2) + state.uy[i10] * fx2 * (1 - fy2) + state.uy[i01] * (1 - fx2) * fy2 + state.uy[i11] * fx2 * fy2;
      // Nhân theo spf: mực trôi theo thời gian SIM, không theo số frame.
      particle.x += vx * DYE_SPEED_SCALE * spf;
      particle.y += vy * DYE_SPEED_SCALE * spf;
      particle.age += spf;
      if (particle.x > NX - 1 || particle.x < 0 || particle.y < 0 || particle.y > NY - 1 || particle.age > DYE_MAX_AGE) particle.alive = false;
    }
    if (dyeRef.current.length > 3200) dyeRef.current = dyeRef.current.filter((particle) => particle.alive);
  }, []);

  /** Bề dày chắn dòng của vật cản hiện tại — quyết định omega từ Reynolds. */
  const measureCharacteristic = (state: LbmState) => {
    let y0 = NY, y1 = -1;
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        if (!state.solid[y * NX + x]) continue;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const cells = y1 >= y0 ? y1 - y0 + 1 : 0;
    characteristicCellsRef.current = cells;
    setCharacteristicCells(cells);
    triggerRegionRef.current = sheddingTriggerRegion(state);
  };

  const applyObstacle = useCallback((state: LbmState, next: ObstacleSource) => {
    clearObstacles(state);
    if (next.kind === "project") {
      // closeRadius 3: hàn các primitive rời thành một khối kín, nếu không thì
      // dòng lách qua kẽ hở và trông như chảy quanh mảnh vụn.
      rasterizeScene(state, scene, { plane: next.plane, angleOfAttackDeg, crossStreamCells: 15, closeRadius: 3 });
    } else if (next.kind === "uav") {
      // Cùng đường rasterize với dự án — mặt cắt là hình học CAD thật của template.
      rasterizeScene(state, uavSectionScene(next.id), { plane: "side", angleOfAttackDeg, crossStreamCells: 15, closeRadius: 3 });
    } else if (next.kind === "shape") {
      LBM_SHAPES.find((shape) => shape.id === next.id)?.build(state, Math.round(NX * 0.24), Math.round(NY / 2));
    }
    measureCharacteristic(state);

    // Hâm nóng đồng bộ: chạy sẵn một đoạn để khung vẽ ĐẦU TIÊN đã có lớp biên,
    // wake và dải mực đầy miền — thay vì để người dùng ngồi xem dòng bò lên.
    // Mực được advect ngay trong hâm nóng theo nhịp frame ảo 5 bước, đúng helper
    // mà vòng RAF dùng, nên chuyển động sau đó nối tiếp liền mạch.
    dyeRef.current = [];
    dyeHueRef.current = 0;
    const cells = characteristicCellsRef.current;
    const warmNu = cells > 0 ? (inflowRef.current * cells) / Math.max(1, reynoldsRef.current) : 0.02;
    const warmOmega = 1 / (3 * warmNu + 0.5);
    const region = triggerRegionRef.current;
    for (let i = 0; i < PREWARM_STEPS; i += 1) {
      stepLbm(state, warmOmega, inflowRef.current, { collision: "mrt", smagorinsky: 0.14 });
      if (region && i < TRIGGER_STEPS) applyTransverseImpulse(state, region, TRIGGER_AMPLITUDE);
      if (dyeFlagRef.current && (i + 1) % PREWARM_STEPS_PER_FRAME === 0) {
        advectDyeFrame(state, PREWARM_STEPS_PER_FRAME);
      }
    }
    stepCounterRef.current = PREWARM_STEPS;
  }, [scene, angleOfAttackDeg, advectDyeFrame]);

  const resetFlow = useCallback((next?: ObstacleSource) => {
    const state = stateRef.current;
    if (!state) return;
    initLbm(state, inflowRef.current);
    stepCounterRef.current = 0;
    // applyObstacle tự dọn và hâm nóng lại dải mực — dọn ở đây sẽ xoá mất nó.
    applyObstacle(state, next ?? source);
    if (scalarRef.current) resetScalarField(scalarRef.current);
    forceHistoryRef.current = [];
    setLive(null);
  }, [applyObstacle, source]);

  useEffect(() => {
    const state = createLbm(NX, NY);
    initLbm(state, 0.095);
    stateRef.current = state;
    scalarRef.current = createScalarField(state);
    const off = document.createElement("canvas");
    off.width = NX;
    off.height = NY;
    offCanvasRef.current = off;
    imageDataRef.current = off.getContext("2d")!.createImageData(NX, NY);
  }, []);

  // Hình học đổi (dự án khác, góc tấn khác, mặt phẳng khác) → dựng lại từ đầu.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    initLbm(state, inflowRef.current);
    stepCounterRef.current = 0;
    applyObstacle(state, source);
    if (scalarRef.current) resetScalarField(scalarRef.current);
    forceHistoryRef.current = [];
    setLive(null);
  }, [applyObstacle, source, projectId]);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let lastFps = performance.now();
    let stepsPerFrame = 3;
    let sampleTick = 0;
    // Glow là thứ đắt nhất trong khung vẽ; nếu máy không giữ được nhịp thì tắt nó
    // trước khi hạ chất lượng mô phỏng.
    let glowEnabled = true;
    const data32 = new Uint32Array(imageDataRef.current!.data.buffer);

    const loop = () => {
      const state = stateRef.current;
      const image = imageDataRef.current;
      const canvas = canvasRef.current;
      const off = offCanvasRef.current;
      if (!state || !image || !canvas || !off) {
        raf = requestAnimationFrame(loop);
        return;
      }
      const u = inflowRef.current;
      const cells = characteristicCellsRef.current;
      // Omega suy từ Reynolds mục tiêu: nu = U·D/Re, tau = 3nu + 0.5.
      const nu = cells > 0 ? (u * cells) / Math.max(1, reynoldsRef.current) : 0.02;
      const omega = 1 / (3 * nu + 0.5);
      const stepOptions = { collision: collisionRef.current, smagorinsky: lesRef.current ? 0.14 : null };

      if (runningRef.current) {
        for (let k = 0; k < stepsPerFrame; k += 1) {
          stepLbm(state, omega, u, stepOptions);
          stepCounterRef.current += 1;
          // Xung ngang phá đối xứng để bất ổn Karman mọc nhanh.
          if (triggerRegionRef.current && stepCounterRef.current < TRIGGER_STEPS) {
            applyTransverseImpulse(state, triggerRegionRef.current, TRIGGER_AMPLITUDE);
          }
          if (smokeRef.current && scalarRef.current) {
            stepScalar(scalarRef.current, state, scalarOmega(0.008), { stripes: DYE_STREAMS, thickness: 2.4, strength: 1 });
          }
        }

        sampleTick += 1;
        const denom = 0.5 * u * u * cells;
        if (denom > 0 && sampleTick % 3 === 0) {
          const { fx, fy } = momentumExchangeForces(state);
          const history = forceHistoryRef.current;
          history.push({ cd: fx / denom, cl: fy / denom });
          if (history.length > 120) history.shift();
        }

        if (dyeFlagRef.current) advectDyeFrame(state, stepsPerFrame);
      }

      // ─ Trường màu qua Uint32 view: 1 lần ghi mỗi pixel ─
      //
      // Colormap được INLINE ở đây thay vì gọi speedColor/vorticityColor: các hàm
      // đó trả về mảng [r,g,b] mới cho từng pixel, tức 42.000 lần cấp phát mỗi
      // frame. Đo được: 2.05 ms/frame khi gọi hàm so với 0.26 ms khi inline —
      // tiết kiệm 88% chi phí vẽ trường, đủ để tăng số bước sim mỗi frame.
      const mode = colorModeRef.current;
      const scaleMax = mode === "vorticity" ? 0.05 : u * 1.5;
      const { solid, ux, uy, rho } = state;
      if (mode === "speed") {
        const inv = 1 / Math.max(scaleMax, 1e-9);
        for (let i = 0; i < state.n; i += 1) {
          if (solid[i]) { data32[i] = SOLID_COLOR; continue; }
          let t = Math.hypot(ux[i], uy[i]) * inv;
          t = t > 1 ? 1 : t < 0 ? 0 : t;
          let r: number, g: number, b: number;
          if (t < 0.25) { const k = t * 4; r = 0; g = (k * 100) | 0; b = (120 + k * 135) | 0; }
          else if (t < 0.5) { const k = (t - 0.25) * 4; r = 0; g = (100 + k * 155) | 0; b = (255 - k * 100) | 0; }
          else if (t < 0.75) { const k = (t - 0.5) * 4; r = (k * 255) | 0; g = 255; b = (155 - k * 155) | 0; }
          else { const k = (t - 0.75) * 4; r = 255; g = (255 - k * 255) | 0; b = 0; }
          data32[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
        }
      } else if (mode === "vorticity") {
        const inv = 1 / Math.max(scaleMax, 1e-9);
        for (let y = 0; y < NY; y += 1) {
          const row = y * NX;
          for (let x = 0; x < NX; x += 1) {
            const i = row + x;
            if (solid[i]) { data32[i] = SOLID_COLOR; continue; }
            let curl = 0;
            if (x > 0 && x < NX - 1 && y > 0 && y < NY - 1) {
              curl = ((uy[row + x + 1] - uy[row + x - 1]) - (ux[(y + 1) * NX + x] - ux[(y - 1) * NX + x])) * 0.5;
            }
            let t = curl * inv;
            t = t > 1 ? 1 : t < -1 ? -1 : t;
            let r: number, g: number, b: number;
            if (t > 0) { r = (255 * t) | 0; g = (60 * t) | 0; b = g; }
            else { const n = -t; r = (60 * n) | 0; g = r; b = (255 * n) | 0; }
            data32[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
          }
        }
      } else {
        for (let i = 0; i < state.n; i += 1) {
          if (solid[i]) { data32[i] = SOLID_COLOR; continue; }
          let t = (rho[i] - 1) * 50;
          t = t > 1 ? 1 : t < -1 ? -1 : t;
          let r: number, g: number, b: number;
          if (t > 0) { r = (80 + t * 175) | 0; g = (80 + t * 100) | 0; b = 80; }
          else { const n = -t; r = 40; g = (60 + n * 100) | 0; b = (80 + n * 175) | 0; }
          data32[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
        }
      }
      off.getContext("2d")!.putImageData(image, 0, 0);

      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      const overlaysOn = dyeFlagRef.current || smokeRef.current;
      if (overlaysOn) {
        ctx.fillStyle = BACKDROP;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = fieldAlphaRef.current;
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
      }

      const sx = canvas.width / NX;
      const sy = canvas.height / NY;

      // ─ Khói: cộng sáng theo nồng độ, bình phương để chỉ phần đặc mới hiện ─
      if (smokeRef.current && scalarRef.current) {
        const concentration = scalarRef.current.c;
        ctx.globalCompositeOperation = "lighter";
        for (let y = 0; y < NY; y += 2) {
          for (let x = 0; x < NX; x += 2) {
            const value = concentration[y * NX + x];
            if (value < 0.06) continue;
            ctx.fillStyle = `rgba(206,222,255,${Math.min(0.5, value * value * 0.7)})`;
            ctx.fillRect(x * sx, y * sy, sx * 2, sy * 2);
          }
        }
        ctx.globalCompositeOperation = "source-over";
      }

      // ─ Dải mực: gộp segment thành ít lệnh stroke ─
      //
      // Bản đầu gọi beginPath+stroke cho TỪNG hạt: tới ~400 lệnh stroke có
      // shadowBlur cộng ~3200 lệnh stroke thường mỗi frame. shadowBlur là một trong
      // những thao tác đắt nhất của canvas 2D, và mỗi lệnh stroke lại tái lập bộ lọc
      // — đủ để FPS sụp, sim bò, và người dùng không bao giờ thấy dòng phát triển.
      //
      // Ở đây gộp theo bucket: mọi segment cùng bucket nằm trong MỘT path và chỉ
      // stroke một lần, nên số lệnh stroke giảm từ ~3600 xuống ~60.
      if (dyeFlagRef.current) {
        const particles = dyeRef.current;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // Pass glow chỉ cho hạt non, và tự tắt khi máy không đủ sức.
        if (glowEnabled) {
          ctx.shadowBlur = 6;
          ctx.lineWidth = 2.4;
          for (let bucket = 0; bucket < DYE_HUE_BUCKETS; bucket += 1) {
            const hue = Math.round((bucket + 0.5) * (360 / DYE_HUE_BUCKETS));
            let opened = false;
            for (const particle of particles) {
              if (!particle.alive || particle.age >= 34) continue;
              if (Math.floor((particle.hue / 360) * DYE_HUE_BUCKETS) % DYE_HUE_BUCKETS !== bucket) continue;
              if (!opened) { ctx.beginPath(); opened = true; }
              ctx.moveTo(particle.prevX * sx, particle.prevY * sy);
              ctx.lineTo(particle.x * sx, particle.y * sy);
            }
            if (opened) {
              ctx.strokeStyle = `hsl(${hue}, 100%, 72%)`;
              ctx.shadowColor = `hsl(${hue}, 100%, 66%)`;
              ctx.stroke();
            }
          }
          ctx.shadowBlur = 0;
        }

        // Pass nét: bucket theo (hue, dải tuổi) để alpha vẫn giảm dần theo tuổi.
        ctx.lineWidth = 2;
        for (let bucket = 0; bucket < DYE_HUE_BUCKETS; bucket += 1) {
          const hue = Math.round((bucket + 0.5) * (360 / DYE_HUE_BUCKETS));
          for (let band = 0; band < DYE_AGE_BANDS; band += 1) {
            const bandLow = 34 + (band / DYE_AGE_BANDS) * (DYE_MAX_AGE - 34);
            const bandHigh = 34 + ((band + 1) / DYE_AGE_BANDS) * (DYE_MAX_AGE - 34);
            let opened = false;
            for (const particle of particles) {
              if (!particle.alive || particle.age < bandLow || particle.age >= bandHigh) continue;
              if (Math.floor((particle.hue / 360) * DYE_HUE_BUCKETS) % DYE_HUE_BUCKETS !== bucket) continue;
              if (!opened) { ctx.beginPath(); opened = true; }
              ctx.moveTo(particle.prevX * sx, particle.prevY * sy);
              ctx.lineTo(particle.x * sx, particle.y * sy);
            }
            if (opened) {
              const midAge = (bandLow + bandHigh) / 2;
              ctx.strokeStyle = `hsla(${hue}, 100%, 66%, ${Math.max(0, 1 - midAge / DYE_MAX_AGE) * 0.9})`;
              ctx.stroke();
            }
          }
        }
        ctx.lineCap = "butt";
        ctx.lineJoin = "miter";
      }

      if (vectorsRef.current) {
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;
        for (let y = 8; y < NY; y += 9) {
          for (let x = 12; x < NX; x += 14) {
            const i = y * NX + x;
            if (state.solid[i]) continue;
            const magnitude = Math.hypot(state.ux[i], state.uy[i]);
            if (magnitude < 0.01) continue;
            const dx = (state.ux[i] / magnitude) * Math.min(magnitude * 60, 13);
            const dy = (state.uy[i] / magnitude) * Math.min(magnitude * 60, 13);
            const px = x * sx;
            const py = y * sy;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px + dx, py + dy);
            ctx.stroke();
            const angle = Math.atan2(dy, dx);
            ctx.beginPath();
            ctx.moveTo(px + dx, py + dy);
            ctx.lineTo(px + dx - 3 * Math.cos(angle - 0.5), py + dy - 3 * Math.sin(angle - 0.5));
            ctx.lineTo(px + dx - 3 * Math.cos(angle + 0.5), py + dy - 3 * Math.sin(angle + 0.5));
            ctx.closePath();
            ctx.fill();
          }
        }
      }

      frames += 1;
      const now = performance.now();
      if (now - lastFps > 500) {
        const measured = Math.round((frames * 1000) / (now - lastFps));
        setFps(measured);
        setStep(stepCounterRef.current);
        const history = forceHistoryRef.current;
        if (history.length > 0 && stepCounterRef.current >= SETTLE_STEPS) {
          const latest = history[history.length - 1];
          const cdMean = history.reduce((sum, item) => sum + item.cd, 0) / history.length;
          const clMean = history.reduce((sum, item) => sum + item.cl, 0) / history.length;
          const clRms = Math.sqrt(history.reduce((sum, item) => sum + (item.cl - clMean) ** 2, 0) / history.length);
          setLive({ cd: latest.cd, cl: latest.cl, cdMean, clRms });
        } else {
          setLive(null);
        }
        if (measured < 45 && glowEnabled) glowEnabled = false;
        else if (measured < 52 && stepsPerFrame > 1) stepsPerFrame -= 1;
        else if (measured >= 58 && stepsPerFrame < 6) stepsPerFrame += 1;
        else if (measured >= 58 && !glowEnabled) glowEnabled = true;
        frames = 0;
        lastFps = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [advectDyeFrame]);

  const toLattice = (event: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * NX, ((event.clientY - rect.top) / rect.height) * NY];
  };

  const paintAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (brushMode === "off") return;
    const state = stateRef.current;
    if (!state) return;
    const [x, y] = toLattice(event);
    paintBrush(state, x, y, 4, brushMode === "add");
  };

  const finishPainting = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const state = stateRef.current;
    if (!state) return;
    measureCharacteristic(state);
    forceHistoryRef.current = [];
  };

  const captureReport = () => {
    const state = stateRef.current;
    if (!state) return;
    const cells = characteristicCellsRef.current;
    const nu = cells > 0 ? (inflowU * cells) / Math.max(1, reynolds) : 0.02;
    setReport(computeLbmReport(state, inflowU, 1 / (3 * nu + 0.5)));
    setCopied(false);
  };

  const copyReport = async () => {
    if (!report) return;
    const markdown = lbmReportToMarkdown(report, {
      title: `Báo cáo LBM — ${projectId.toUpperCase()}`,
      generatedAt: new Date().toLocaleString("vi-VN"),
      cdMean: live?.cdMean,
      clRms: live?.clRms,
      siNote: `Vận tốc thực đặt trong workbench là ${velocityMs} m/s; Cd/Cl không thứ nguyên nên dùng trực tiếp cho F = C · ½ρU²A. Collision: ${collision.toUpperCase()}${les ? " + Smagorinsky LES" : ""}.`,
    });
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const downloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `${projectId}-lbm-${colorMode}-Re${reynolds}-step${stepCounterRef.current}.png`;
    link.click();
  };

  const projectPlane = source.kind === "project" ? source.plane : null;
  // Trục y của lưới hướng xuống: lực nâng là -fy, trừ mặt bằng thì fy là lực
  // ngang theo +Z nên giữ nguyên dấu.
  const liftSign = projectPlane === "top" ? 1 : -1;

  return <section className="lbm-panel">
    <header>
      <span>SOLVER TRỰC TIẾP · LATTICE BOLTZMANN D2Q9</span>
      <div className="lbm-live">
        <b>{fps} FPS</b>
        <span>{step.toLocaleString()} bước</span>
        <span>{collision.toUpperCase()}{les ? " + LES" : ""}</span>
        <span>Re {reynolds}</span>
      </div>
    </header>

    <div className="lbm-toolbar">
      <div className="lbm-group">
        <label>HÌNH HỌC</label>
        <button className={projectPlane === "side" ? "active" : ""} onClick={() => setSource({ kind: "project", plane: "side" })}>DỰ ÁN · MẶT CẠNH</button>
        <button className={projectPlane === "top" ? "active" : ""} onClick={() => setSource({ kind: "project", plane: "top" })}>DỰ ÁN · MẶT BẰNG</button>
        <button className={source.kind === "blank" ? "active" : ""} onClick={() => setSource({ kind: "blank" })}>MIỀN TRỐNG</button>
      </div>
      <div className="lbm-group">
        <label>TRƯỜNG</label>
        {(["vorticity", "speed", "pressure"] as LbmColorMode[]).map((mode) => (
          <button key={mode} className={colorMode === mode ? "active" : ""} onClick={() => setColorMode(mode)}>
            {mode === "vorticity" ? "XOÁY" : mode === "speed" ? "VẬN TỐC" : "ÁP SUẤT"}
          </button>
        ))}
      </div>
      <div className="lbm-group">
        <label>COLLISION</label>
        <button className={collision === "mrt" ? "active" : ""} onClick={() => setCollision("mrt")} title="Multi-relaxation-time — ổn định tới Re ≈ 12.000">MRT</button>
        <button className={collision === "bgk" ? "active" : ""} onClick={() => setCollision("bgk")} title="BGK — nhanh hơn nhưng nổ từ Re ≈ 3.000">BGK</button>
        <button className={les ? "active" : ""} onClick={() => setLes((value) => !value)} title="Nhớt rối Smagorinsky dưới lưới">LES</button>
      </div>
      <div className="lbm-group">
        <label>LỚP PHỦ</label>
        <button className={showDye ? "active" : ""} onClick={() => setShowDye((value) => !value)}>≋ MỰC</button>
        <button className={dyePalette === "spectrum" ? "active" : ""} onClick={() => setDyePalette("spectrum")}>PHỔ</button>
        <button className={dyePalette === "brand" ? "active" : ""} onClick={() => setDyePalette("brand")}>BRAND</button>
        <button className={showSmoke ? "active" : ""} onClick={() => setShowSmoke((value) => !value)} title="Trường khói D2Q5 — đối lưu–khuếch tán">☁ KHÓI</button>
        <button className={showVectors ? "active" : ""} onClick={() => setShowVectors((value) => !value)}>→ VECTOR</button>
      </div>
      <div className="lbm-group">
        <label>ĐIỀU KHIỂN</label>
        <button className={running ? "active" : ""} onClick={() => setRunning((value) => !value)}>{running ? "❚❚ DỪNG" : "▶ CHẠY"}</button>
        <button onClick={() => resetFlow()}>↺ ĐẶT LẠI</button>
        <button className="primary" onClick={captureReport}>⎘ BÁO CÁO</button>
      </div>
    </div>

    <div className="lbm-shape-row lbm-uav-row">
      <label>MẶT CẮT UAV</label>
      {UAV_SECTIONS.map((section) => (
        <button
          key={section.id}
          className={source.kind === "uav" && source.id === section.id ? "active" : ""}
          title={section.desc}
          onClick={() => setSource({ kind: "uav", id: section.id })}
        >
          <i>{section.icon}</i>{section.label}
        </button>
      ))}
    </div>

    <div className="lbm-shape-row">
      <label>VẬT CẢN MẪU</label>
      {LBM_SHAPES.map((shape) => (
        <button
          key={shape.id}
          className={source.kind === "shape" && source.id === shape.id ? "active" : ""}
          title={shape.desc}
          onClick={() => setSource({ kind: "shape", id: shape.id })}
        >
          <i>{shape.icon}</i>{shape.label}
        </button>
      ))}
    </div>

    <div className="lbm-stage">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className={brushMode === "off" ? "" : "drawing"}
        onMouseDown={(event) => { drawingRef.current = true; paintAt(event); }}
        onMouseMove={(event) => { if (drawingRef.current) paintAt(event); }}
        onMouseUp={finishPainting}
        onMouseLeave={finishPainting}
      />
      <div className="lbm-overlay-left">
        <span>INLET {inflowU.toFixed(3)} lu/ts ≡ {velocityMs} m/s</span>
        <span>Re {reynolds} · D {characteristicCells} ô</span>
        {projectPlane && <span>BÓNG {projectPlane === "side" ? "MẶT CẠNH (X–Y)" : "MẶT BẰNG (X–Z)"} · AOA {angleOfAttackDeg}°</span>}
        {source.kind === "uav" && <span>MẶT CẮT {UAV_SECTIONS.find((section) => section.id === source.id)?.label.toUpperCase()} · AOA {angleOfAttackDeg}°</span>}
      </div>
      {!live && <div className="lbm-overlay-right settling">
        <b>ĐANG PHÁT TRIỂN DÒNG</b>
        <span>{Math.min(100, Math.round((step / SETTLE_STEPS) * 100))}% · cần {SETTLE_STEPS} bước</span>
      </div>}
      {live && <div className="lbm-overlay-right">
        <b>Cd {live.cdMean.toFixed(3)}</b>
        <span>tức thời {live.cd.toFixed(3)}</span>
        <b>{projectPlane === "top" ? "Cy" : "Cl"} {(liftSign * live.cl).toFixed(3)}</b>
        <span>RMS {live.clRms.toFixed(3)}</span>
      </div>}
    </div>

    <div className="lbm-controls">
      <label>
        <span>REYNOLDS <b>{reynolds}</b></span>
        <input type="range" min="20" max="6000" step="20" value={reynolds} onChange={(event) => setReynolds(Number(event.target.value))} />
      </label>
      <label>
        <span>VẬN TỐC LATTICE <b>{inflowU.toFixed(3)} lu/ts</b></span>
        <input type="range" min="0.03" max="0.16" step="0.005" value={inflowU} onChange={(event) => setInflowU(Number(event.target.value))} />
      </label>
      <label>
        <span>ĐỘ ĐẬM TRƯỜNG <b>{fieldAlpha.toFixed(2)}</b></span>
        <input type="range" min="0.1" max="1" step="0.02" value={fieldAlpha} onChange={(event) => setFieldAlpha(Number(event.target.value))} />
      </label>
      <div className="lbm-brush">
        <span>SỬA VẬT CẢN BẰNG CHUỘT</span>
        <div>
          {(["off", "add", "erase"] as const).map((mode) => (
            <button key={mode} className={brushMode === mode ? "active" : ""} onClick={() => setBrushMode(mode)}>
              {mode === "off" ? "TẮT" : mode === "add" ? "+ THÊM" : "− XOÁ"}
            </button>
          ))}
        </div>
      </div>
    </div>

    {report && <div className="lbm-report">
      <header>
        <span>BÁO CÁO TẠI BƯỚC {report.sim.step.toLocaleString()}</span>
        <div>
          <button onClick={copyReport}>{copied ? "✓ ĐÃ COPY" : "⧉ COPY MARKDOWN"}</button>
          <button onClick={downloadPng}>⇩ PNG</button>
          <button onClick={() => setReport(null)}>✕</button>
        </div>
      </header>
      <div className="lbm-report-grid">
        <span>Re mô phỏng<b>{report.reynolds.toFixed(0)}</b></span>
        <span>Cd (MEM)<b>{report.forces.cd.toFixed(3)}</b></span>
        <span>{projectPlane === "top" ? "Cy ngang (MEM)" : "Cl nâng (MEM)"}<b>{(liftSign * report.forces.cl).toFixed(3)}</b></span>
        <span>D<b>{report.obstacle.characteristicCells} ô</b></span>
        <span>Chắn kênh<b>{(report.obstacle.blockageRatio * 100).toFixed(1)}%</b></span>
        <span>Hụt wake<b>{report.flow.wakeDeficitPct.toFixed(0)}%</b></span>
        <span>u max<b>{report.flow.maxSpeed.toFixed(4)}</b></span>
        <span>Δp (ρ−1)<b>{report.flow.minPressure.toFixed(4)} ↔ {report.flow.maxPressure.toFixed(4)}</b></span>
      </div>
      <article>
        <b>{report.regime.label}</b>
        <p>{report.regime.interpretation}</p>
        <small>{report.regime.benchmark}</small>
        {report.obstacle.blockageRatio > 0.12 && <small className="warn">Tỷ lệ chắn kênh {(report.obstacle.blockageRatio * 100).toFixed(0)}% khá cao — tường trên/dưới bó dòng lại nên Cd đo được lớn hơn giá trị không gian tự do.</small>}
      </article>
    </div>}

    <p className="lbm-note">
      Solver giải Navier–Stokes 2D trên bóng chiếu hình học CAD. <b>MRT</b> (multi-relaxation-time) giữ ổn định tới Re ≈ 12.000
      trong khi <b>BGK</b> nổ từ Re ≈ 3.000 (đổi lại MRT chậm hơn 22%); <b>LES</b> thêm nhớt rối Smagorinsky ở nơi dòng bị xé mạnh. 300 bước đầu có bơm xung
      ngang để bất ổn Karman mọc nhanh. Đây là mô phỏng 2D ở Reynolds thấp hơn điều kiện bay thực — dùng để so sánh phương án
      hình học và nhìn thấy wake/tách dòng, không dùng làm số liệu chứng nhận.
    </p>
  </section>;
}
