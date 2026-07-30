/**
 * cfd-lbm — Lattice Boltzmann D2Q9 solver (Navier–Stokes 2D, không nén được).
 *
 * Ported từ module CFD của Aeroedu Vision (labs/CFDFlow) và mở rộng cho DIY
 * Studio. So với `cfd-engine.ts` (ước lượng giải tích từ hình học), file này
 * GIẢI THẬT trường dòng trên lưới, nên Cd/Cl là số ĐO ĐƯỢC chứ không phải
 * tương quan kinh nghiệm.
 *
 * Khác biệt chính so với bản gốc Aeroedu:
 *   1. Không phụ thuộc DOM/React — chạy được trong node (test, MCP) và browser.
 *   2. Lưới tham số hoá (nx, ny) thay vì hằng số module.
 *   3. `rasterizeScene()` chiếu bóng hình học CAD của DIY lên lưới → mô phỏng
 *      đúng dự án của người dùng, không chỉ preset cylinder/airfoil.
 *   4. `deriveLatticeSetup()` khớp Reynolds thực (m/s, mm, không khí) sang đơn
 *      vị lattice → Cd đo được quy đổi lại lực SI.
 *   5. Hệ số lực dùng đúng chuẩn Cd = 2·Fx/(ρ·U²·D) (bản gốc thiếu hệ số 2).
 *   6. `solveLbm()` chạy headless: warm-up → lấy mẫu lực → RMS + Strouhal.
 *
 * Tham chiếu: Mohamad (2011) "Lattice Boltzmann Method" §3 (BGK), §4.6
 * (momentum-exchange method cho lực trên biên).
 */

import type { ScenePrimitive } from "./cad-engine.js";

// ─── Hằng số D2Q9 ────────────────────────────────────────────────
// 9 hướng vận tốc: 0 = nghỉ, 1-4 = trục, 5-8 = chéo.
export const Q = 9;
export const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1] as const;
export const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1] as const;
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36] as const;
/** Hướng đối (dùng cho bounce-back). */
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6] as const;

/** Độ nhớt động học của không khí ở 15°C, mực nước biển [m²/s]. */
export const AIR_KINEMATIC_VISCOSITY = 1.51e-5;
/** Độ nhớt động học của nước biển ở 15°C [m²/s]. */
export const SEAWATER_KINEMATIC_VISCOSITY = 1.004e-6;

/** Dải omega ổn định của BGK: τ > 0.5 và τ không quá gần 0.5 (nhớt ~ 0). */
export const OMEGA_MIN = 0.4;
export const OMEGA_MAX = 1.96;

export type LbmState = {
  nx: number;
  ny: number;
  n: number;
  /** Hàm phân bố: n*Q, layout [cell*9 + q]. */
  f: Float32Array;
  fNew: Float32Array;
  /** 1 = solid (vật cản), 0 = fluid. */
  solid: Uint8Array;
  rho: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
  /** Bảng chỉ số nguồn streaming đã tính trước: streamSrc[cell*9+q]. */
  streamSrc: Int32Array;
  /** Số bước đã chạy kể từ `initLbm`. */
  step: number;
};

export function cellIndex(state: { nx: number }, x: number, y: number) {
  return y * state.nx + x;
}

/**
 * Bảng streaming kiểu "pull": streamSrc[target*9+q] = ô nguồn của f_q.
 * Loại bỏ 2 phép modulo mỗi ô mỗi hướng mỗi bước (~415K ops/bước ở 240×96).
 */
function precomputeStreaming(nx: number, ny: number): Int32Array {
  const table = new Int32Array(nx * ny * Q);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const target = y * nx + x;
      for (let q = 0; q < Q; q += 1) {
        const xs = (x - EX[q] + nx) % nx;
        const ys = (y - EY[q] + ny) % ny;
        table[target * Q + q] = (ys * nx + xs) * Q + q;
      }
    }
  }
  return table;
}

export function createLbm(nx = 240, ny = 96): LbmState {
  const n = nx * ny;
  return {
    nx,
    ny,
    n,
    f: new Float32Array(n * Q),
    fNew: new Float32Array(n * Q),
    solid: new Uint8Array(n),
    rho: new Float32Array(n),
    ux: new Float32Array(n),
    uy: new Float32Array(n),
    streamSrc: precomputeStreaming(nx, ny),
    step: 0,
  };
}

/**
 * Khởi tạo dòng đều + nhiễu nhỏ để phá vỡ đối xứng số học (cần thiết cho
 * vortex shedding xuất hiện). `noise = 0` cho kết quả tiền định (dùng test).
 */
export function initLbm(state: LbmState, inflowU: number, noise = 0.01, random: () => number = Math.random) {
  const { f, rho, ux, uy, n } = state;
  for (let i = 0; i < n; i += 1) {
    const rhoI = 1;
    const uxI = inflowU + (random() - 0.5) * noise;
    const uyI = (random() - 0.5) * noise;
    rho[i] = rhoI;
    ux[i] = uxI;
    uy[i] = uyI;
    const u2 = (uxI * uxI + uyI * uyI) * 1.5;
    const base = i * 9;
    f[base + 0] = (4 / 9) * rhoI * (1 - u2);
    f[base + 1] = (1 / 9) * rhoI * (1 + 3 * uxI + 4.5 * uxI * uxI - u2);
    f[base + 2] = (1 / 9) * rhoI * (1 + 3 * uyI + 4.5 * uyI * uyI - u2);
    f[base + 3] = (1 / 9) * rhoI * (1 - 3 * uxI + 4.5 * uxI * uxI - u2);
    f[base + 4] = (1 / 9) * rhoI * (1 - 3 * uyI + 4.5 * uyI * uyI - u2);
    const e5 = uxI + uyI;
    f[base + 5] = (1 / 36) * rhoI * (1 + 3 * e5 + 4.5 * e5 * e5 - u2);
    const e6 = -uxI + uyI;
    f[base + 6] = (1 / 36) * rhoI * (1 + 3 * e6 + 4.5 * e6 * e6 - u2);
    const e7 = -uxI - uyI;
    f[base + 7] = (1 / 36) * rhoI * (1 + 3 * e7 + 4.5 * e7 * e7 - u2);
    const e8 = uxI - uyI;
    f[base + 8] = (1 / 36) * rhoI * (1 + 3 * e8 + 4.5 * e8 * e8 - u2);
  }
  state.step = 0;
}

/**
 * Nửa bước 1: streaming (pull) + toàn bộ điều kiện biên (inlet, outlet, tường,
 * bounce-back trên vật cản).
 *
 * Tách riêng khỏi collision vì lực trên biên (momentum exchange) phải đo trên
 * đúng các hàm phân bố vừa phản xạ khỏi thành vật — sau collision thì giá trị
 * đã bị pha loãng bởi toán tử BGK và Cd đo được sẽ lệch cao.
 *
 * Tối ưu (giữ từ bản Aeroedu): bảng streamSrc, inline feq 9 hướng, hằng số
 * EX/EY/W hard-code trong vòng lặp nóng, swap buffer thủ công.
 */
export function streamAndApplyBoundaries(state: LbmState, inflowU: number) {
  const { nx, ny, n, solid, rho, ux, uy, streamSrc } = state;
  let f = state.f;
  const fNew = state.fNew;

  // ─ Streaming (pull) ─
  for (let i = 0; i < n; i += 1) {
    const base = i * 9;
    fNew[base + 0] = f[streamSrc[base + 0]];
    fNew[base + 1] = f[streamSrc[base + 1]];
    fNew[base + 2] = f[streamSrc[base + 2]];
    fNew[base + 3] = f[streamSrc[base + 3]];
    fNew[base + 4] = f[streamSrc[base + 4]];
    fNew[base + 5] = f[streamSrc[base + 5]];
    fNew[base + 6] = f[streamSrc[base + 6]];
    fNew[base + 7] = f[streamSrc[base + 7]];
    fNew[base + 8] = f[streamSrc[base + 8]];
  }
  const tmp = state.f;
  state.f = state.fNew;
  state.fNew = tmp;
  f = state.f;

  // ─ Inlet trái (x=0): áp vận tốc U, ρ=1, tái tạo feq (hằng số theo y) ─
  const u2 = inflowU * inflowU * 1.5;
  const fin0 = (4 / 9) * (1 - u2);
  const fin1 = (1 / 9) * (1 + 3 * inflowU + 4.5 * inflowU * inflowU - u2);
  const fin2 = (1 / 9) * (1 - u2);
  const fin3 = (1 / 9) * (1 - 3 * inflowU + 4.5 * inflowU * inflowU - u2);
  const fin4 = (1 / 9) * (1 - u2);
  const fin5 = (1 / 36) * (1 + 3 * inflowU + 4.5 * inflowU * inflowU - u2);
  const fin6 = (1 / 36) * (1 - 3 * inflowU + 4.5 * inflowU * inflowU - u2);
  const fin7 = (1 / 36) * (1 - 3 * inflowU + 4.5 * inflowU * inflowU - u2);
  const fin8 = (1 / 36) * (1 + 3 * inflowU + 4.5 * inflowU * inflowU - u2);
  for (let y = 1; y < ny - 1; y += 1) {
    const i = y * nx;
    ux[i] = inflowU;
    uy[i] = 0;
    rho[i] = 1;
    const base = i * 9;
    f[base + 0] = fin0; f[base + 1] = fin1; f[base + 2] = fin2;
    f[base + 3] = fin3; f[base + 4] = fin4; f[base + 5] = fin5;
    f[base + 6] = fin6; f[base + 7] = fin7; f[base + 8] = fin8;
  }
  // ─ Outlet phải (x=nx-1): zero-gradient, copy từ x=nx-2 ─
  for (let y = 1; y < ny - 1; y += 1) {
    const baseR = (y * nx + (nx - 1)) * 9;
    const baseL = (y * nx + (nx - 2)) * 9;
    for (let q = 0; q < 9; q += 1) f[baseR + q] = f[baseL + q];
  }
  // ─ Biên trên/dưới: phản xạ gương (free-slip / far-field) ─
  //
  // Chiều nào là ĐÃ BIẾT sau streaming quyết định toàn bộ chỗ này. Bảng streaming
  // là tuần hoàn, nên tại y=0 các hướng có EY=+1 (q=2,5,6) bị kéo từ y=-1 → cuộn
  // về tường đối diện ⇒ CHƯA BIẾT, phải do biên sinh ra. Các hướng EY=-1
  // (q=4,7,8) kéo từ y=1 nằm trong miền ⇒ ĐÃ BIẾT.
  //
  // Bản gốc (port từ Aeroedu) gán ngược: `f[top+4] = f[top+2]`, tức ghi đè giá trị
  // ĐÚNG bằng giá trị cuộn từ tường đối diện. Hậu quả đo được: khối lượng trôi
  // +0.65% sau 400 bước trong kênh TRỐNG, và áp suất giả 0.031 ở góc inlet — gấp
  // đôi thang điểm dừng vật lý 0.015 tại nơi không có vật cản.
  //
  // Chọn phản xạ GƯƠNG chứ không phải bounce-back: đây là biên miền ngoài của bài
  // toán khí động ngoại vi (UI gọi là "FAR-FIELD / SLIP"), nên phải bảo toàn động
  // lượng tiếp tuyến. Bounce-back sẽ tạo lớp biên nhớt giả trên hai tường và bó
  // dòng thêm — đo được nó đẩy Cd trụ tròn Re=100 từ 1.44 lên 2.23.
  // Gương lật thành phần pháp tuyến, giữ thành phần tiếp tuyến:
  //   trên:  q4(0,-1)→q2(0,+1) · q7(-1,-1)→q6(-1,+1) · q8(1,-1)→q5(1,+1)
  for (let x = 0; x < nx; x += 1) {
    const topBase = x * 9;
    const botBase = ((ny - 1) * nx + x) * 9;
    f[topBase + 2] = f[topBase + 4];
    f[topBase + 6] = f[topBase + 7];
    f[topBase + 5] = f[topBase + 8];
    f[botBase + 4] = f[botBase + 2];
    f[botBase + 7] = f[botBase + 6];
    f[botBase + 8] = f[botBase + 5];
  }
  // ─ Vật cản: bounce-back no-slip (đổi chỗ từng cặp hướng đối) ─
  for (let i = 0; i < n; i += 1) {
    if (!solid[i]) continue;
    const base = i * 9;
    let t = f[base + 1]; f[base + 1] = f[base + 3]; f[base + 3] = t;
    t = f[base + 2]; f[base + 2] = f[base + 4]; f[base + 4] = t;
    t = f[base + 5]; f[base + 5] = f[base + 7]; f[base + 7] = t;
    t = f[base + 6]; f[base + 6] = f[base + 8]; f[base + 8] = t;
  }
}

/** Nửa bước 2: macroscopic (ρ, u) + collision BGK, gộp một vòng lặp. */
export function collide(state: LbmState, omega: number) {
  const { n, solid, rho, ux, uy } = state;
  const f = state.f;
  const omneg = 1 - omega;
  for (let i = 0; i < n; i += 1) {
    if (solid[i]) {
      rho[i] = 1;
      ux[i] = 0;
      uy[i] = 0;
      continue;
    }
    const base = i * 9;
    const f0 = f[base + 0], f1 = f[base + 1], f2 = f[base + 2], f3 = f[base + 3];
    const f4 = f[base + 4], f5 = f[base + 5], f6 = f[base + 6], f7 = f[base + 7];
    const f8 = f[base + 8];
    const r = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
    const inv = r > 0.001 ? 1 / r : 1;
    const uxI = (f1 - f3 + f5 - f6 - f7 + f8) * inv;
    const uyI = (f2 - f4 + f5 + f6 - f7 - f8) * inv;
    rho[i] = r;
    ux[i] = uxI;
    uy[i] = uyI;
    const uu = (uxI * uxI + uyI * uyI) * 1.5;
    f[base + 0] = omneg * f0 + omega * (4 / 9) * r * (1 - uu);
    f[base + 1] = omneg * f1 + omega * (1 / 9) * r * (1 + 3 * uxI + 4.5 * uxI * uxI - uu);
    f[base + 2] = omneg * f2 + omega * (1 / 9) * r * (1 + 3 * uyI + 4.5 * uyI * uyI - uu);
    f[base + 3] = omneg * f3 + omega * (1 / 9) * r * (1 - 3 * uxI + 4.5 * uxI * uxI - uu);
    f[base + 4] = omneg * f4 + omega * (1 / 9) * r * (1 - 3 * uyI + 4.5 * uyI * uyI - uu);
    const e5 = uxI + uyI;
    f[base + 5] = omneg * f5 + omega * (1 / 36) * r * (1 + 3 * e5 + 4.5 * e5 * e5 - uu);
    const e6 = -uxI + uyI;
    f[base + 6] = omneg * f6 + omega * (1 / 36) * r * (1 + 3 * e6 + 4.5 * e6 * e6 - uu);
    const e7 = -uxI - uyI;
    f[base + 7] = omneg * f7 + omega * (1 / 36) * r * (1 + 3 * e7 + 4.5 * e7 * e7 - uu);
    const e8 = uxI - uyI;
    f[base + 8] = omneg * f8 + omega * (1 / 36) * r * (1 + 3 * e8 + 4.5 * e8 * e8 - uu);
  }
  state.step += 1;
}

// ─── MRT: collision đa thời gian hồi phục ────────────────────────
//
// BGK hồi phục mọi moment về cân bằng với CÙNG một tốc độ omega, nên khi omega
// tiến tới 2 (nhớt → 0, Re cao) các moment không bảo toàn mất ổn định và solver
// nổ. MRT (Lallemand & Luo 2000) đổi sang không gian moment và cho mỗi moment
// một tốc độ riêng: moment ứng suất giữ đúng omega để ra đúng độ nhớt, còn các
// moment bậc cao được hồi phục nhanh hơn để dập nhiễu số học.
//
// Bộ vận tốc của file này trùng đúng thứ tự chuẩn Lallemand–Luo:
//   c0=(0,0) c1=(1,0) c2=(0,1) c3=(-1,0) c4=(0,-1) c5=(1,1) c6=(-1,1)
//   c7=(-1,-1) c8=(1,-1)
// nên dùng được ma trận M chuẩn. Các hàng của M trực giao, chuẩn bình phương lần
// lượt là [9,36,36,6,12,6,12,4,4], nên M⁻¹ = Mᵀ·diag(1/norm) — nhờ đó biến đổi
// nghịch chỉ là tổ hợp cộng với hệ số nguyên nhỏ, không cần nhân ma trận đầy.

/**
 * Tốc độ hồi phục của các moment không bảo toàn, thứ tự (e, eps, q).
 *
 * Bộ mặc định là bộ Lallemand–Luo cho chế độ Re cao: moment bậc cao (q) hồi phục
 * NHANH (≈1.9) để dập nhiễu số học.
 *
 * Cảnh báo đã kiểm chứng bằng thực nghiệm: dùng "magic parameter"
 * Λ = (1/s_q − 0.5)(1/s_ν − 0.5) = 3/16 cho s_q thì ở omega cao s_q tụt xuống
 * gần 0 (omega=1.96 ⇒ s_q≈0.017), các moment bậc cao gần như không hồi phục và
 * solver nổ ngay — chậm hơn cả BGK. Magic parameter chỉ nên dùng ở Re thấp khi
 * cần đúng vị trí thành, không dùng cho mục tiêu ổn định.
 */
export type MrtRates = { energy: number; energySquare: number; flux: number };

export const MRT_RATES_STABLE: MrtRates = { energy: 1.64, energySquare: 1.54, flux: 1.9 };

/**
 * Nhớt rối Smagorinsky: lấy ứng suất ngoài cân bằng Π làm thước đo biến dạng
 * cục bộ rồi cộng thêm nhớt xoáy ở nơi dòng bị xé mạnh. Nhờ đó lưới thô chạy
 * được Re cao mà không nổ, thay vì phải hạ Re xuống cho ổn định.
 *
 * Trả về omega hiệu dụng tại ô đó (nhớt lớn hơn ⇒ omega nhỏ hơn).
 */
function smagorinskyOmega(omega: number, pxxNeq: number, pxyNeq: number, constant: number) {
  // Moment m7 = Σ(cx²−cy²)f = Πxx − Πyy. Dòng không nén 2D có tensor lệch
  // trace-free (Πyy = −Πxx), nên Πxx = m7neq/2 và Πxy = m8neq.
  const pxx = pxxNeq / 2;
  const pyy = -pxx;
  const norm = Math.sqrt(2 * (pxx * pxx + 2 * pxyNeq * pxyNeq + pyy * pyy));
  const tau0 = 1 / omega;
  // Nghiệm hiện của τ_eff: tại biến dạng 0 thì τ_eff = τ0 (thoái về laminar),
  // biến dạng càng lớn thì nhớt xoáy càng cộng thêm.
  const tauEff = 0.5 * (tau0 + Math.sqrt(tau0 * tau0 + 18 * Math.SQRT2 * constant * constant * norm));
  return 1 / Math.max(tauEff, 0.5 + 1e-6);
}

/**
 * Collision MRT, tuỳ chọn kèm Smagorinsky LES.
 * `lesConstant` = null ⇒ tắt LES; 0.1–0.18 là dải Smagorinsky thường dùng.
 */
export function collideMrt(state: LbmState, omega: number, lesConstant: number | null = null, rates: MrtRates = MRT_RATES_STABLE) {
  const { n, solid, rho, ux, uy } = state;
  const f = state.f;
  const s1 = rates.energy;
  const s2 = rates.energySquare;
  const sq = rates.flux;

  for (let i = 0; i < n; i += 1) {
    if (solid[i]) {
      rho[i] = 1;
      ux[i] = 0;
      uy[i] = 0;
      continue;
    }
    const base = i * 9;
    const f0 = f[base], f1 = f[base + 1], f2 = f[base + 2], f3 = f[base + 3];
    const f4 = f[base + 4], f5 = f[base + 5], f6 = f[base + 6], f7 = f[base + 7];
    const f8 = f[base + 8];

    // ─ Sang không gian moment (hệ số của M đều là số nguyên nhỏ) ─
    const m0 = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;                       // rho
    const m1 = -4 * f0 - f1 - f2 - f3 - f4 + 2 * (f5 + f6 + f7 + f8);            // e
    const m2 = 4 * f0 - 2 * (f1 + f2 + f3 + f4) + f5 + f6 + f7 + f8;             // eps
    const m3 = f1 - f3 + f5 - f6 - f7 + f8;                                      // jx
    const m4 = -2 * f1 + 2 * f3 + f5 - f6 - f7 + f8;                             // qx
    const m5 = f2 - f4 + f5 + f6 - f7 - f8;                                      // jy
    const m6 = -2 * f2 + 2 * f4 + f5 + f6 - f7 - f8;                             // qy
    const m7 = f1 - f2 + f3 - f4;                                                // pxx
    const m8 = f5 - f6 + f7 - f8;                                                // pxy

    const density = m0 > 0.001 ? m0 : 1;
    const inv = 1 / density;
    const jx = m3;
    const jy = m5;
    const jSquared = (jx * jx + jy * jy) * inv;

    // ─ Moment cân bằng ─
    const m1eq = -2 * m0 + 3 * jSquared;
    const m2eq = m0 - 3 * jSquared;
    const m4eq = -jx;
    const m6eq = -jy;
    const m7eq = (jx * jx - jy * jy) * inv;
    const m8eq = jx * jy * inv;

    // ─ Tốc độ hồi phục của moment ứng suất: omega, có thể bị LES điều chỉnh ─
    let sNu = omega;
    if (lesConstant !== null) {
      sNu = smagorinskyOmega(omega, m7 - m7eq, m8 - m8eq, lesConstant);
    }

    // ─ Hồi phục từng moment ─
    const c0 = m0 / 9;
    const c1 = (m1 - s1 * (m1 - m1eq)) / 36;
    const c2 = (m2 - s2 * (m2 - m2eq)) / 36;
    const c3 = jx / 6;
    const c4 = (m4 - sq * (m4 - m4eq)) / 12;
    const c5 = jy / 6;
    const c6 = (m6 - sq * (m6 - m6eq)) / 12;
    const c7 = (m7 - sNu * (m7 - m7eq)) / 4;
    const c8 = (m8 - sNu * (m8 - m8eq)) / 4;

    // ─ Về không gian phân bố: f_i = Σ_j M[j][i]·m*_j/norm_j ─
    const diag = c0 + 2 * c1 + c2;
    f[base] = c0 - 4 * c1 + 4 * c2;
    f[base + 1] = c0 - c1 - 2 * c2 + c3 - 2 * c4 + c7;
    f[base + 2] = c0 - c1 - 2 * c2 + c5 - 2 * c6 - c7;
    f[base + 3] = c0 - c1 - 2 * c2 - c3 + 2 * c4 + c7;
    f[base + 4] = c0 - c1 - 2 * c2 - c5 + 2 * c6 - c7;
    f[base + 5] = diag + c3 + c4 + c5 + c6 + c8;
    f[base + 6] = diag - c3 - c4 + c5 + c6 - c8;
    f[base + 7] = diag - c3 - c4 - c5 - c6 + c8;
    f[base + 8] = diag + c3 + c4 - c5 - c6 - c8;

    rho[i] = m0;
    ux[i] = jx * inv;
    uy[i] = jy * inv;
  }
  state.step += 1;
}

export type CollisionModel = "bgk" | "mrt";

export type StepOptions = {
  /** "bgk" nhanh và đủ cho Re thấp; "mrt" ổn định ở Re cao. */
  collision?: CollisionModel;
  /** Hằng số Smagorinsky cho LES (chỉ dùng với MRT); null = tắt. */
  smagorinsky?: number | null;
};

/** Một bước LBM đầy đủ: streaming + biên → collision. */
export function stepLbm(state: LbmState, omega: number, inflowU: number, options: StepOptions = {}) {
  streamAndApplyBoundaries(state, inflowU);
  if (options.collision === "mrt") collideMrt(state, omega, options.smagorinsky ?? null);
  else collide(state, omega);
}

// ─── Vận chuyển vô hướng thụ động (D2Q5) — trường khói ───────────
//
// Hạt mực rời rạc chỉ vẽ được vài chục dải mảnh. Muốn trường khói ĐẶC như video
// CFD thì phải giải phương trình đối lưu–khuếch tán cho một trường nồng độ, trên
// một lattice riêng D2Q5 (đủ cho bài toán vô hướng, rẻ hơn D2Q9 gần một nửa).
//
//   ∂C/∂t + u·∇C = D ∇²C
//
// Trường này được vận tốc của lattice D2Q9 kéo theo (one-way coupling): khói
// không tác động lại lên dòng, đúng nghĩa "thụ động".

const SEX = [0, 1, 0, -1, 0] as const;
const SEY = [0, 0, 1, 0, -1] as const;
const SW = [1 / 3, 1 / 6, 1 / 6, 1 / 6, 1 / 6] as const;
const SQ = 5;

export type ScalarField = {
  nx: number;
  ny: number;
  n: number;
  g: Float32Array;
  gNew: Float32Array;
  /** Nồng độ khói, 0..1. */
  c: Float32Array;
  streamSrc: Int32Array;
};

export function createScalarField(state: LbmState): ScalarField {
  const { nx, ny, n } = state;
  const streamSrc = new Int32Array(n * SQ);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const target = y * nx + x;
      for (let q = 0; q < SQ; q += 1) {
        const xs = (x - SEX[q] + nx) % nx;
        const ys = (y - SEY[q] + ny) % ny;
        streamSrc[target * SQ + q] = (ys * nx + xs) * SQ + q;
      }
    }
  }
  return { nx, ny, n, g: new Float32Array(n * SQ), gNew: new Float32Array(n * SQ), c: new Float32Array(n), streamSrc };
}

export function resetScalarField(field: ScalarField) {
  field.g.fill(0);
  field.gNew.fill(0);
  field.c.fill(0);
}

/** Đổi hệ số khuếch tán sang tốc độ hồi phục của lattice vô hướng. */
export function scalarOmega(diffusivity: number) {
  return 1 / (3 * Math.max(diffusivity, 1e-4) + 0.5);
}

export type ScalarInjection = {
  /** Số dải khói phát từ inlet. */
  stripes: number;
  /** Bề dày mỗi dải, tính bằng ô. */
  thickness: number;
  /** Nồng độ tại nguồn. */
  strength: number;
};

/**
 * Một bước đối lưu–khuếch tán của trường khói, dùng vận tốc hiện tại của `state`.
 * Vật cản là biên không thấm (bounce-back ⇒ thông lượng bằng 0).
 */
export function stepScalar(field: ScalarField, state: LbmState, omegaC: number, injection: ScalarInjection | null) {
  const { nx, ny, n, streamSrc, c } = field;
  const { solid, ux, uy } = state;
  let g = field.g;
  const gNew = field.gNew;

  for (let i = 0; i < n; i += 1) {
    const base = i * SQ;
    gNew[base] = g[streamSrc[base]];
    gNew[base + 1] = g[streamSrc[base + 1]];
    gNew[base + 2] = g[streamSrc[base + 2]];
    gNew[base + 3] = g[streamSrc[base + 3]];
    gNew[base + 4] = g[streamSrc[base + 4]];
  }
  const swap = field.g;
  field.g = field.gNew;
  field.gNew = swap;
  g = field.g;

  // Vật cản: không thấm — đảo cặp hướng đối.
  for (let i = 0; i < n; i += 1) {
    if (!solid[i]) continue;
    const base = i * SQ;
    let t = g[base + 1]; g[base + 1] = g[base + 3]; g[base + 3] = t;
    t = g[base + 2]; g[base + 2] = g[base + 4]; g[base + 4] = t;
  }

  // Bảng streaming là tuần hoàn, nên nếu không chặn biên thì khói ra khỏi mép
  // phải sẽ quay lại mép trái (quan sát được: vệt lược ở inlet và mảng nhiễu ở
  // outlet). Ba biên dưới đây biến miền tuần hoàn thành kênh hở.
  for (let y = 0; y < ny; y += 1) {
    // Outlet phải: zero-gradient, khói thoát ra không dội lại.
    const right = (y * nx + (nx - 1)) * SQ;
    const inner = (y * nx + (nx - 2)) * SQ;
    for (let q = 0; q < SQ; q += 1) g[right + q] = g[inner + q];
    // Inlet trái: khí sạch, chỉ có nguồn phun mới đưa khói vào.
    const left = y * nx * SQ;
    for (let q = 0; q < SQ; q += 1) g[left + q] = 0;
  }
  // Biên trên/dưới: thông lượng bằng 0, chặn khói cuộn dọc qua biên tuần hoàn.
  // Cùng quy ước known/unknown như lattice D2Q9: tại y=0 hướng SEY=+1 (q=2) bị kéo
  // từ y=-1 nên CHƯA BIẾT, hướng SEY=-1 (q=4) kéo từ y=1 nên ĐÃ BIẾT. Gán ngược
  // chiều sẽ ghi đè giá trị đúng và làm khói thất thoát ở tường.
  for (let x = 0; x < nx; x += 1) {
    const top = x * SQ;
    const bottom = ((ny - 1) * nx + x) * SQ;
    g[top + 2] = g[top + 4];
    g[bottom + 4] = g[bottom + 2];
  }

  // Nguồn khói tại inlet: các dải ngang cách đều.
  if (injection && injection.stripes > 0) {
    const half = Math.max(0.5, injection.thickness / 2);
    for (let stripe = 0; stripe < injection.stripes; stripe += 1) {
      const centre = (ny * (stripe + 0.5)) / injection.stripes;
      for (let y = Math.max(1, Math.round(centre - half)); y <= Math.min(ny - 2, Math.round(centre + half)); y += 1) {
        for (let x = 1; x <= 2; x += 1) {
          const i = y * nx + x;
          if (solid[i]) continue;
          const base = i * SQ;
          const u = ux[i], v = uy[i];
          for (let q = 0; q < SQ; q += 1) {
            g[base + q] = SW[q] * injection.strength * (1 + 3 * (SEX[q] * u + SEY[q] * v));
          }
        }
      }
    }
  }

  // Macroscopic + collision.
  for (let i = 0; i < n; i += 1) {
    if (solid[i]) { c[i] = 0; continue; }
    const base = i * SQ;
    const g0 = g[base], g1 = g[base + 1], g2 = g[base + 2], g3 = g[base + 3], g4 = g[base + 4];
    const concentration = g0 + g1 + g2 + g3 + g4;
    c[i] = concentration;
    const u = ux[i], v = uy[i];
    const omneg = 1 - omegaC;
    g[base] = omneg * g0 + omegaC * SW[0] * concentration;
    g[base + 1] = omneg * g1 + omegaC * SW[1] * concentration * (1 + 3 * u);
    g[base + 2] = omneg * g2 + omegaC * SW[2] * concentration * (1 + 3 * v);
    g[base + 3] = omneg * g3 + omegaC * SW[3] * concentration * (1 - 3 * u);
    g[base + 4] = omneg * g4 + omegaC * SW[4] * concentration * (1 - 3 * v);
  }
}

// ─── Kích xoáy: phá đối xứng để Karman mọc nhanh ─────────────────

/**
 * Vật cản đối xứng + nhiễu khởi tạo đối xứng ⇒ mất RẤT lâu để bất ổn Karman mọc
 * lên (đo được: ClRms chỉ đạt 0.35 sau ~10.000 bước, tức hơn một phút ở 60fps).
 * Bơm một xung động lượng ngang ngắn ngay sau vật cản sẽ gieo trực tiếp mode phản
 * đối xứng, xoáy cuộn rõ chỉ sau 1–2 nghìn bước.
 *
 * Lực đưa vào theo dạng Guo bậc nhất: f_i += 3·w_i·(c_i·F).
 */
export function applyTransverseImpulse(state: LbmState, region: { x0: number; x1: number; y0: number; y1: number }, amplitude: number) {
  const { nx, ny, solid } = state;
  const f = state.f;
  for (let y = Math.max(1, region.y0); y <= Math.min(ny - 2, region.y1); y += 1) {
    for (let x = Math.max(1, region.x0); x <= Math.min(nx - 2, region.x1); x += 1) {
      const i = y * nx + x;
      if (solid[i]) continue;
      const base = i * 9;
      for (let q = 1; q < 9; q += 1) {
        f[base + q] += 3 * W[q] * EY[q] * amplitude;
      }
    }
  }
}

/**
 * Vùng kích xoáy suy ra từ hộp bao vật cản: một dải mỏng ngay sau đuôi, lệch về
 * nửa trên để phá đối xứng.
 */
export function sheddingTriggerRegion(state: LbmState) {
  const { nx, ny, solid } = state;
  let x1 = -1, y0 = ny, y1 = -1;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      if (!solid[y * nx + x]) continue;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const midY = Math.round((y0 + y1) / 2);
  return { x0: x1 + 1, x1: Math.min(nx - 2, x1 + 6), y0: Math.max(1, y0), y1: midY };
}

// ─── Làm liền khối mặt nạ vật cản ────────────────────────────────

/**
 * Đóng hình thái học (dilate rồi erode) bán kính `radius`.
 *
 * Cần thiết vì bóng chiếu của scene CAD gồm nhiều primitive rời (thân, cần, động
 * cơ, cánh quạt) nên rasterize ra các mảng KHÔNG liền nhau — dòng chảy lách qua
 * các kẽ hở và trông như chảy quanh mảnh vụn, không phải quanh một khí cụ. Đóng
 * hình thái học hàn các kẽ nhỏ hơn 2·radius thành một khối kín.
 */
export function closeSolidMask(state: LbmState, radius: number) {
  if (radius <= 0) return;
  const { nx, ny, n } = state;
  const offsets: number[] = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push(dy * nx + dx);
    }
  }
  const dilated = new Uint8Array(n);
  for (let y = radius; y < ny - radius; y += 1) {
    for (let x = radius; x < nx - radius; x += 1) {
      const i = y * nx + x;
      if (!state.solid[i]) continue;
      for (const offset of offsets) dilated[i + offset] = 1;
    }
  }
  const eroded = new Uint8Array(n);
  for (let y = radius; y < ny - radius; y += 1) {
    for (let x = radius; x < nx - radius; x += 1) {
      const i = y * nx + x;
      let all = 1;
      for (const offset of offsets) {
        if (!dilated[i + offset]) { all = 0; break; }
      }
      eroded[i] = all;
    }
  }
  // Hợp với mặt nạ gốc để không bao giờ làm mất chi tiết đã có.
  for (let i = 0; i < n; i += 1) if (eroded[i]) state.solid[i] = 1;
}

/** Xoáy (curl) tại ô (x,y) bằng sai phân trung tâm. */
export function vorticityAt(state: LbmState, x: number, y: number) {
  const { nx, ny, ux, uy } = state;
  if (x <= 0 || x >= nx - 1 || y <= 0 || y >= ny - 1) return 0;
  const row = y * nx;
  const duydx = uy[row + (x + 1)] - uy[row + (x - 1)];
  const duxdy = ux[(y + 1) * nx + x] - ux[(y - 1) * nx + x];
  return (duydx - duxdy) * 0.5;
}

// ─── Thư viện vật cản ────────────────────────────────────────────
// Mọi hàm chỉ SET solid=1 (không clear) → cho phép ghép nhiều shape.

export function clearObstacles(state: LbmState) {
  state.solid.fill(0);
}

function markSolid(state: LbmState, x: number, y: number) {
  if (x < 0 || x >= state.nx || y < 0 || y >= state.ny) return;
  state.solid[y * state.nx + x] = 1;
}

export function presetCylinder(state: LbmState, cx: number, cy: number, r: number) {
  const x0 = Math.floor(cx - r) - 1, x1 = Math.ceil(cx + r) + 1;
  const y0 = Math.floor(cy - r) - 1, y1 = Math.ceil(cy + r) + 1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < r * r) markSolid(state, x, y);
    }
  }
}

/** Ellipse bán trục a (dọc dòng), b (vuông góc), xoay theta rad. */
export function presetEllipse(state: LbmState, cx: number, cy: number, a: number, b: number, theta = 0) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const R = Math.ceil(Math.max(a, b)) + 1;
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y += 1) {
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x += 1) {
      const dx = x - cx, dy = y - cy;
      const rx = c * dx + s * dy;
      const ry = -s * dx + c * dy;
      if ((rx * rx) / (a * a) + (ry * ry) / (b * b) < 1) markSolid(state, x, y);
    }
  }
}

/** Hình chữ nhật xoay theta rad — dùng cho tấm phẳng và bóng khối hộp. */
export function presetRect(state: LbmState, cx: number, cy: number, halfW: number, halfH: number, theta = 0) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const R = Math.ceil(Math.hypot(halfW, halfH)) + 1;
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y += 1) {
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x += 1) {
      const dx = x - cx, dy = y - cy;
      const rx = c * dx + s * dy;
      const ry = -s * dx + c * dy;
      if (Math.abs(rx) <= halfW && Math.abs(ry) <= halfH) markSolid(state, x, y);
    }
  }
}

export function presetSquare(state: LbmState, cx: number, cy: number, half: number) {
  presetRect(state, cx, cy, half, half, 0);
}

export function presetPlate(state: LbmState, cx: number, cy: number, height: number, thickness = 3, angle = 0) {
  presetRect(state, cx, cy, thickness / 2, height / 2, angle);
}

export function presetDiamond(state: LbmState, cx: number, cy: number, half: number) {
  for (let y = Math.round(cy - half); y <= Math.round(cy + half); y += 1) {
    const w = half - Math.abs(y - cy);
    if (w < 0) continue;
    for (let x = Math.round(cx - w); x <= Math.round(cx + w); x += 1) markSolid(state, x, y);
  }
}

/** dir "left" = mũi nhọn đón dòng (wedge cản); "right" = mặt phẳng đón dòng. */
export function presetTriangle(state: LbmState, cx: number, cy: number, size: number, dir: "left" | "right" = "left") {
  for (let y = Math.round(cy - size); y <= Math.round(cy + size); y += 1) {
    const w = size - Math.abs(y - cy);
    if (w <= 0) continue;
    for (let x = -w; x <= w; x += 1) markSolid(state, dir === "left" ? Math.round(cx + x) : Math.round(cx - x), y);
  }
}

export function presetHalfCircle(state: LbmState, cx: number, cy: number, r: number, flat: "top" | "bottom" | "left" | "right" = "bottom") {
  for (let y = Math.round(cy - r); y <= Math.round(cy + r); y += 1) {
    for (let x = Math.round(cx - r); x <= Math.round(cx + r); x += 1) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy >= r * r) continue;
      const keep = flat === "bottom" ? dy <= 0 : flat === "top" ? dy >= 0 : flat === "left" ? dx >= 0 : dx <= 0;
      if (keep) markSolid(state, x, y);
    }
  }
}

export function presetCross(state: LbmState, cx: number, cy: number, size: number, thick: number) {
  presetPlate(state, cx, cy, size * 2, thick, 0);
  presetPlate(state, cx, cy, size * 2, thick, Math.PI / 2);
}

/** Airfoil dạng NACA teardrop nghiêng góc tấn `aoaRad` (mũi trái). */
export function presetAirfoil(state: LbmState, cx: number, cy: number, len: number, thick: number, aoaRad = 0) {
  const c = Math.cos(aoaRad), s = Math.sin(aoaRad);
  const R = Math.ceil(Math.max(len, thick)) + 1;
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y += 1) {
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x += 1) {
      const px = x - cx, py = y - cy;
      const rx = (c * px + s * py) / len;
      const ry = (-s * px + c * py) / thick;
      if (rx < -1 || rx > 1) continue;
      const yMax = Math.sqrt(Math.max(0, 1 - rx * rx)) * 0.6 * (1 + rx);
      if (Math.abs(ry) < yMax) markSolid(state, x, y);
    }
  }
}

/** Giọt nước: tròn đầu, thuôn đuôi — ít wake nhất trong thư viện. */
export function presetTeardrop(state: LbmState, cx: number, cy: number, len: number, thick: number) {
  for (let y = Math.round(cy - thick); y <= Math.round(cy + thick); y += 1) {
    for (let x = Math.round(cx - len); x <= Math.round(cx + len); x += 1) {
      const t = (x - cx + len) / (2 * len);
      let halfH: number;
      if (t < 0.3) {
        const localX = (0.3 - t) * 2 * len;
        const r = thick * 0.6;
        halfH = Math.sqrt(Math.max(0, r * r - localX * localX));
      } else {
        halfH = thick * (1 - (t - 0.3) / 0.7);
      }
      if (Math.abs(y - cy) < halfH) markSolid(state, x, y);
    }
  }
}

/** Nêm: đỉnh nhọn đón dòng, đáy phẳng phía sau. */
export function presetWedge(state: LbmState, cx: number, cy: number, len: number, halfBase: number) {
  for (let x = Math.round(cx - len); x <= Math.round(cx); x += 1) {
    const t = (x - (cx - len)) / len;
    const halfH = halfBase * t;
    for (let y = Math.round(cy - halfH); y <= Math.round(cy + halfH); y += 1) markSolid(state, x, y);
  }
}

export function presetTandem(state: LbmState, cx: number, cy: number, r: number, gap: number) {
  presetCylinder(state, cx - gap / 2, cy, r);
  presetCylinder(state, cx + gap / 2, cy, r);
}

export function presetSideBySide(state: LbmState, cx: number, cy: number, r: number, gap: number) {
  presetCylinder(state, cx, cy - gap / 2, r);
  presetCylinder(state, cx, cy + gap / 2, r);
}

export function presetCylinderArray(state: LbmState, cx: number, cy: number, nCol: number, nRow: number, spacing: number, r: number) {
  const x0 = cx - ((nCol - 1) * spacing) / 2;
  const y0 = cy - ((nRow - 1) * spacing) / 2;
  for (let row = 0; row < nRow; row += 1) {
    for (let col = 0; col < nCol; col += 1) presetCylinder(state, x0 + col * spacing, y0 + row * spacing, r);
  }
}

/** Máng chữ U (cavity flow). */
export function presetUChannel(state: LbmState, cx: number, cy: number, w: number, h: number, t: number) {
  presetRect(state, cx, cy + h - t / 2, w, t / 2);
  presetRect(state, cx - w + t / 2, cy, t / 2, h);
  presetRect(state, cx + w - t / 2, cy, t / 2, h);
}

/** Bóng cạnh xe hơi (thân + mui nghiêng + 2 bánh) — demo khí động ô tô. */
export function presetCar(state: LbmState, cx: number, cy: number, scale: number) {
  const bodyW = scale * 2.5, bodyH = scale * 0.6;
  const roofW = scale * 1.2, roofH = scale * 0.6;
  presetRect(state, cx, cy + bodyH / 2, bodyW, bodyH / 2);
  for (let y = Math.round(cy - roofH); y <= Math.round(cy); y += 1) {
    const t = (cy - y) / roofH;
    for (let x = Math.round(cx - roofW + t * roofW * 0.4); x <= Math.round(cx + roofW); x += 1) markSolid(state, x, y);
  }
  presetCylinder(state, cx - bodyW * 0.6, cy + bodyH, scale * 0.35);
  presetCylinder(state, cx + bodyW * 0.6, cy + bodyH, scale * 0.35);
}

/** Tô đa giác (ray casting) — dùng cho công cụ vẽ tự do trong UI. */
export function fillPolygon(state: LbmState, verts: Array<[number, number]>) {
  if (verts.length < 3) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of verts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const inside = (px: number, py: number) => {
    let hit = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i, i += 1) {
      const [xi, yi] = verts[i];
      const [xj, yj] = verts[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(state.ny - 1, Math.ceil(maxY)); y += 1) {
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(state.nx - 1, Math.ceil(maxX)); x += 1) {
      if (inside(x + 0.5, y + 0.5)) markSolid(state, x, y);
    }
  }
}

/** Cọ tròn (thêm/xoá) cho tương tác chuột. */
export function paintBrush(state: LbmState, cx: number, cy: number, radius: number, add: boolean) {
  for (let y = Math.round(cy - radius); y <= Math.round(cy + radius); y += 1) {
    for (let x = Math.round(cx - radius); x <= Math.round(cx + radius); x += 1) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) continue;
      if (x < 0 || x >= state.nx || y < 0 || y >= state.ny) continue;
      state.solid[y * state.nx + x] = add ? 1 : 0;
    }
  }
}

// ─── Catalog shape cho UI ────────────────────────────────────────

export type LbmShapeId =
  | "cylinder" | "square" | "diamond" | "triangleL" | "triangleR"
  | "ellipseH" | "ellipseV" | "plateV" | "plateInclined" | "dome" | "cross"
  | "airfoil" | "airfoilAoa" | "teardrop" | "wedge"
  | "tandem" | "sideBySide" | "cylArr23"
  | "car" | "uChannel";

export type LbmShapeDef = {
  id: LbmShapeId;
  label: string;
  icon: string;
  category: "basic" | "aero" | "array" | "case";
  desc: string;
  build: (state: LbmState, cx: number, cy: number) => void;
};

export const LBM_SHAPES: LbmShapeDef[] = [
  { id:"cylinder", label:"Trụ tròn", icon:"⬤", category:"basic", desc:"Karman vortex street khi Re ≥ 100", build:(s, cx, cy) => presetCylinder(s, cx, cy, 10) },
  { id:"square", label:"Vuông", icon:"■", category:"basic", desc:"Tách dòng tại cạnh nhọn", build:(s, cx, cy) => presetSquare(s, cx, cy, 8) },
  { id:"diamond", label:"Thoi 45°", icon:"◆", category:"basic", desc:"Xoáy rời từ hai đỉnh trên/dưới", build:(s, cx, cy) => presetDiamond(s, cx, cy, 11) },
  { id:"triangleL", label:"Tam giác cản", icon:"◀", category:"basic", desc:"Mũi nhọn đón dòng", build:(s, cx, cy) => presetTriangle(s, cx, cy, 11, "left") },
  { id:"triangleR", label:"Tam giác thuận", icon:"▶", category:"basic", desc:"Mặt phẳng đón dòng, đuôi nhọn", build:(s, cx, cy) => presetTriangle(s, cx, cy, 11, "right") },
  { id:"ellipseH", label:"Elip ngang", icon:"⬭", category:"basic", desc:"Thuôn dọc dòng — cản thấp", build:(s, cx, cy) => presetEllipse(s, cx, cy, 16, 7) },
  { id:"ellipseV", label:"Elip đứng", icon:"⏺", category:"basic", desc:"Tiết diện đứng — cản lớn", build:(s, cx, cy) => presetEllipse(s, cx, cy, 7, 16) },
  { id:"plateV", label:"Tấm phẳng đứng", icon:"┃", category:"basic", desc:"Bluff body cản tối đa", build:(s, cx, cy) => presetPlate(s, cx, cy, 28, 3, 0) },
  { id:"plateInclined", label:"Tấm nghiêng 30°", icon:"╲", category:"basic", desc:"Sinh cả lực nâng và lực cản", build:(s, cx, cy) => presetPlate(s, cx, cy, 28, 3, Math.PI / 6) },
  { id:"dome", label:"Nửa cầu", icon:"◐", category:"basic", desc:"Đáy phẳng — tách dòng sau", build:(s, cx, cy) => presetHalfCircle(s, cx, cy, 12, "bottom") },
  { id:"cross", label:"Chữ thập", icon:"✚", category:"basic", desc:"Wake phức hợp nhiều tầng", build:(s, cx, cy) => presetCross(s, cx, cy, 12, 4) },
  { id:"airfoil", label:"Cánh 0°", icon:"✈", category:"aero", desc:"NACA-like, góc tấn 0", build:(s, cx, cy) => presetAirfoil(s, cx, cy, 20, 8) },
  { id:"airfoilAoa", label:"Cánh 10°", icon:"🛫", category:"aero", desc:"Góc tấn 10° — Cl > 0", build:(s, cx, cy) => presetAirfoil(s, cx, cy, 20, 8, Math.PI / 18) },
  { id:"teardrop", label:"Giọt nước", icon:"💧", category:"aero", desc:"Tròn đầu, thuôn đuôi — ít wake", build:(s, cx, cy) => presetTeardrop(s, cx, cy, 18, 8) },
  { id:"wedge", label:"Nêm", icon:"⊿", category:"aero", desc:"Mũi nêm, đáy phẳng", build:(s, cx, cy) => presetWedge(s, cx, cy, 18, 8) },
  { id:"tandem", label:"2 trụ nối tiếp", icon:"⬤⬤", category:"array", desc:"Nhiễu wake trụ trước lên trụ sau", build:(s, cx, cy) => presetTandem(s, cx, cy, 7, 26) },
  { id:"sideBySide", label:"2 trụ song song", icon:"⫶", category:"array", desc:"Vortex shedding cặp đôi", build:(s, cx, cy) => presetSideBySide(s, cx, cy, 7, 28) },
  { id:"cylArr23", label:"Lưới 3×2 trụ", icon:"▦", category:"array", desc:"Bó ống trao đổi nhiệt", build:(s, cx, cy) => presetCylinderArray(s, cx, cy, 3, 2, 18, 5) },
  { id:"car", label:"Thân xe", icon:"🚗", category:"case", desc:"Khí động ô tô (mặt cạnh)", build:(s, cx, cy) => presetCar(s, cx, cy - 6, 10) },
  { id:"uChannel", label:"Máng chữ U", icon:"⊔", category:"case", desc:"Cavity flow trong khoang hở", build:(s, cx, cy) => presetUChannel(s, cx, cy, 14, 10, 3) },
];

// ─── Chiếu hình học CAD của DIY lên lưới ─────────────────────────

export type LbmPlane = "side" | "top";

export type SceneRasterOptions = {
  /** "side" = mặt cạnh (X–Y, dòng theo +X); "top" = mặt bằng (X–Z). */
  plane?: LbmPlane;
  /**
   * Bề dày chắn dòng mong muốn, tính bằng ô lưới. Đây là tham số quyết định
   * chất lượng: D là chiều dài đặc trưng của Re và Cd, nên phải đủ ô để
   * bounce-back giải được lớp biên (≥ 12), đồng thời đủ nhỏ so với chiều cao
   * miền để không bị hiệu ứng bó dòng (≤ ~12% ny).
   */
  crossStreamCells?: number;
  /** Ngân sách chiều dài theo hướng dòng [ô] — chỉ dùng để hạ tỷ lệ nếu thân quá dài. */
  chordCells?: number;
  /** Vị trí tâm bóng theo % chiều dài miền (0..1). */
  centerFraction?: number;
  /** Góc tấn (độ, mũi lên là dương) — xoay bóng quanh tâm hình học. */
  angleOfAttackDeg?: number;
  /** Bỏ qua chi tiết nhỏ hơn ngưỡng này (ô) để tránh nhiễu lưới. */
  minFeatureCells?: number;
  /**
   * Bán kính đóng hình thái học [ô] để hàn các primitive rời thành một khối kín.
   * 0 = tắt. Mặc định 2 vì bóng chiếu scene CAD gần như luôn bị rời rạc.
   */
  closeRadius?: number;
};

export type SceneRasterResult = {
  plane: LbmPlane;
  /** Số ô solid đã đánh dấu. */
  solidCells: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  /** mm ứng với một ô lưới. */
  cellSizeMm: number;
  /** Kích thước hình học thật theo hướng dòng và vuông góc dòng [mm]. */
  streamwiseMm: number;
  crossStreamMm: number;
  /** Chiều dài đặc trưng D dùng cho Re/Cd — bề dày lớn nhất chắn dòng [mm]. */
  characteristicMm: number;
  /** Primitive bị bỏ (quá nhỏ so với lưới, hoặc chỉ là chi tiết phụ). */
  skipped: string[];
  usedPrimitives: number;
};

/** Kind nào chiếu thành ellipse (thân tròn), còn lại là chữ nhật. */
const ROUND_KINDS = new Set<ScenePrimitive["kind"]>(["cylinder", "motor", "sphere", "cone", "tube", "lathe"]);
/** Kind nào bỏ hẳn: dây và vít không ảnh hưởng dòng ở mức lưới này. */
const SKIP_KINDS = new Set<ScenePrimitive["kind"]>(["wire", "screw"]);

/**
 * Rasterize bóng của scene CAD lên lưới LBM. Đây là cầu nối riêng của DIY:
 * Aeroedu chỉ có preset hình học, còn ở đây solver chạy trên đúng hình dáng
 * dự án người dùng đang thiết kế.
 *
 * Quy ước trục: CAD dùng X = dọc thân, Y = lên, Z = ngang. Lưới LBM dùng X là
 * hướng dòng và Y hướng xuống màn hình, nên mặt cạnh phải lật dấu Y.
 */
export function rasterizeScene(state: LbmState, scene: ScenePrimitive[], options: SceneRasterOptions = {}): SceneRasterResult {
  const plane = options.plane ?? "side";
  const crossStreamCells = Math.max(6, options.crossStreamCells ?? Math.max(12, Math.round(state.ny * 0.1)));
  const chordBudgetCells = Math.max(8, options.chordCells ?? Math.round(state.nx * 0.55));
  const centerFraction = Math.min(0.8, Math.max(0.12, options.centerFraction ?? 0.3));
  const minFeatureCells = options.minFeatureCells ?? 0.9;
  const theta = ((options.angleOfAttackDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);

  type Footprint = { id: string; u: number; v: number; du: number; dv: number; round: boolean };
  const footprints: Footprint[] = [];
  const skipped: string[] = [];
  for (const primitive of scene) {
    if (SKIP_KINDS.has(primitive.kind) || primitive.role === "cutout") { skipped.push(primitive.id); continue; }
    // Vật thể gần trong suốt chỉ là chỉ dẫn hình ảnh (vd vòng bảo vệ cánh quạt).
    if (primitive.opacity !== undefined && primitive.opacity < 0.35) { skipped.push(primitive.id); continue; }
    const u = primitive.position[0];
    const v = plane === "side" ? -primitive.position[1] : primitive.position[2];
    const du = Math.abs(primitive.size[0]);
    const dv = Math.abs(plane === "side" ? primitive.size[1] : primitive.size[2]);
    if (du <= 0 || dv <= 0) { skipped.push(primitive.id); continue; }
    footprints.push({ id: primitive.id, u, v, du, dv, round: ROUND_KINDS.has(primitive.kind) });
  }
  if (footprints.length === 0) {
    return { plane, solidCells: 0, bbox: null, cellSizeMm: 1, streamwiseMm: 0, crossStreamMm: 0, characteristicMm: 0, skipped, usedPrimitives: 0 };
  }

  // Bounding box trong hệ đã xoay theo góc tấn (mm).
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const rotated = footprints.map((footprint) => {
    const ru = cos * footprint.u - sin * footprint.v;
    const rv = sin * footprint.u + cos * footprint.v;
    // Nửa kích thước của hộp bao sau khi xoay (dùng cho bbox tổng).
    const halfU = (Math.abs(cos) * footprint.du + Math.abs(sin) * footprint.dv) / 2;
    const halfV = (Math.abs(sin) * footprint.du + Math.abs(cos) * footprint.dv) / 2;
    minU = Math.min(minU, ru - halfU);
    maxU = Math.max(maxU, ru + halfU);
    minV = Math.min(minV, rv - halfV);
    maxV = Math.max(maxV, rv + halfV);
    return { ...footprint, ru, rv };
  });

  const streamwiseMm = Math.max(maxU - minU, 0.001);
  const crossStreamMm = Math.max(maxV - minV, 0.001);
  // Ưu tiên phân giải bề dày chắn dòng, rồi hạ tỷ lệ nếu thân dài quá ngân
  // sách theo hướng dòng; cuối cùng vẫn giữ tối thiểu 4 ô theo hướng dòng để
  // thân mảnh (tấm phẳng) không biến mất khỏi lưới.
  const scale = Math.max(
    Math.min(crossStreamCells / crossStreamMm, chordBudgetCells / streamwiseMm),
    4 / streamwiseMm,
  );
  const cellSizeMm = 1 / scale;
  const originX = centerFraction * state.nx - (streamwiseMm * scale) / 2;
  const midV = (minV + maxV) / 2;
  const centerY = state.ny / 2;

  let usedPrimitives = 0;
  for (const footprint of rotated) {
    const halfW = (footprint.du * scale) / 2;
    const halfH = (footprint.dv * scale) / 2;
    if (Math.max(halfW, halfH) * 2 < minFeatureCells) { skipped.push(footprint.id); continue; }
    const cx = originX + (footprint.ru - minU) * scale;
    const cy = centerY + (footprint.rv - midV) * scale;
    if (footprint.round) presetEllipse(state, cx, cy, Math.max(halfW, 0.5), Math.max(halfH, 0.5), theta);
    else presetRect(state, cx, cy, Math.max(halfW, 0.5), Math.max(halfH, 0.5), theta);
    usedPrimitives += 1;
  }

  closeSolidMask(state, options.closeRadius ?? 2);

  // bbox thực tế trên lưới + đếm ô solid.
  let x0 = state.nx, x1 = -1, y0 = state.ny, y1 = -1, solidCells = 0;
  for (let y = 0; y < state.ny; y += 1) {
    for (let x = 0; x < state.nx; x += 1) {
      if (!state.solid[y * state.nx + x]) continue;
      solidCells += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const bbox = solidCells > 0 ? { x0, y0, x1, y1 } : null;
  // D = bề dày chắn dòng (cross-stream) — chuẩn cho Cd/Re của bluff body.
  const characteristicMm = bbox ? (y1 - y0 + 1) * cellSizeMm : crossStreamMm;
  return { plane, solidCells, bbox, cellSizeMm, streamwiseMm, crossStreamMm, characteristicMm, skipped, usedPrimitives };
}

// ─── Quy đổi lattice ↔ SI ────────────────────────────────────────

export type LatticeSetupOptions = {
  /** Vận tốc dòng thực [m/s]. */
  velocityMs: number;
  /** Chiều dài đặc trưng thực [m] (thường là bề dày chắn dòng). */
  characteristicLengthM: number;
  /** Chiều dài đặc trưng trên lưới [ô]. */
  characteristicCells: number;
  /** Độ nhớt động học của môi chất [m²/s]. */
  kinematicViscosityM2S?: number;
  /** Vận tốc lattice mong muốn (0.05–0.15 là vùng an toàn của BGK). */
  latticeVelocity?: number;
};

export type LatticeSetup = {
  latticeVelocity: number;
  omega: number;
  tau: number;
  nuLattice: number;
  /** Re vật lý muốn khớp. */
  reynoldsPhysical: number;
  /** Re thực sự mô phỏng được sau khi kẹp omega vào vùng ổn định. */
  reynoldsLattice: number;
  clamped: boolean;
  note: string;
};

/**
 * Khớp Reynolds thực sang đơn vị lattice. LBM D2Q9 chỉ ổn định trong dải
 * τ ∈ (0.5, ~2.5]; Re thực của UAV (10⁵–10⁶) vượt xa khả năng của lưới vài
 * chục nghìn ô, nên omega bị kẹp và ta báo rõ Re thực sự đang mô phỏng.
 */
export function deriveLatticeSetup(options: LatticeSetupOptions): LatticeSetup {
  const nu = options.kinematicViscosityM2S ?? AIR_KINEMATIC_VISCOSITY;
  const latticeVelocity = Math.min(0.18, Math.max(0.02, options.latticeVelocity ?? 0.09));
  const cells = Math.max(4, options.characteristicCells);
  const reynoldsPhysical = (Math.max(0.01, options.velocityMs) * Math.max(1e-4, options.characteristicLengthM)) / nu;
  const nuTarget = (latticeVelocity * cells) / Math.max(1, reynoldsPhysical);
  const tauTarget = 3 * nuTarget + 0.5;
  const omegaTarget = 1 / tauTarget;
  const omega = Math.min(OMEGA_MAX, Math.max(OMEGA_MIN, omegaTarget));
  const clamped = Math.abs(omega - omegaTarget) > 1e-9;
  const tau = 1 / omega;
  const nuLattice = (tau - 0.5) / 3;
  const reynoldsLattice = (latticeVelocity * cells) / nuLattice;
  const note = clamped
    ? `Re thực ${Math.round(reynoldsPhysical).toLocaleString()} vượt dải ổn định của lưới ${cells} ô; solver chạy ở Re ${Math.round(reynoldsLattice).toLocaleString()} (cùng chế độ wake, khác độ lớn nhớt).`
    : `Lưới khớp đúng Re ${Math.round(reynoldsLattice).toLocaleString()} của điều kiện bay thực.`;
  return { latticeVelocity, omega, tau, nuLattice, reynoldsPhysical, reynoldsLattice, clamped, note };
}

// ─── Lực trên biên bằng Momentum Exchange Method ─────────────────

export type MomentumForces = { fx: number; fy: number };

/**
 * MEM (Mohamad 2011 §4.6). Tính TẠI Ô SOLID: với mỗi hướng q mà ô lân cận
 * x+e_q là fluid, f_q sau bounce-back chính là hàm phân bố vừa phản xạ khỏi
 * thành. Hạt tới mang động lượng −e_q·f, rời đi mang +e_q·f, nên lực lên vật
 * là −2·e_q·f_q. Đơn vị lattice (lu).
 *
 * Vì `collide()` không tác động lên ô solid, cách tính này cho cùng một kết
 * quả bất kể gọi trước hay sau collision — đo từ UI ở thời điểm nào cũng đúng.
 * (Bản Aeroedu gốc tính tại ô fluid nên chỉ đúng khi gọi sau collision.)
 */
export function momentumExchangeForces(state: LbmState): MomentumForces {
  const { nx, ny, solid, f } = state;
  let fx = 0, fy = 0;
  for (let y = 1; y < ny - 1; y += 1) {
    for (let x = 1; x < nx - 1; x += 1) {
      const i = y * nx + x;
      if (!solid[i]) continue;
      const base = i * 9;
      for (let q = 1; q < 9; q += 1) {
        const neighbour = (y + EY[q]) * nx + (x + EX[q]);
        if (solid[neighbour]) continue;
        const w = 2 * f[base + q];
        fx -= EX[q] * w;
        fy -= EY[q] * w;
      }
    }
  }
  return { fx, fy };
}

// ─── Báo cáo ─────────────────────────────────────────────────────

export type LbmRegime = {
  label: string;
  interpretation: string;
  benchmark: string;
};

export type LbmReport = {
  grid: { nx: number; ny: number; totalCells: number };
  sim: { latticeVelocity: number; omega: number; tau: number; nu: number; step: number };
  obstacle: {
    solidCells: number;
    bbox: { x0: number; y0: number; x1: number; y1: number } | null;
    characteristicCells: number;
    coverage: number;
    hasObstacle: boolean;
    /**
     * Tỷ lệ chắn kênh D/ny. Trên ~10% thì tường trên/dưới bó dòng lại và Cd đo
     * được cao hơn giá trị không gian tự do (blockage effect) — cần biết khi so
     * với benchmark.
     */
    blockageRatio: number;
  };
  flow: { maxSpeed: number; avgSpeed: number; wakeAvgSpeed: number; wakeDeficitPct: number; maxVorticity: number; maxPressure: number; minPressure: number };
  forces: { fx: number; fy: number; cd: number; cl: number };
  reynolds: number;
  regime: LbmRegime;
};

/** Diễn giải chế độ dòng theo Reynolds, lấy trụ tròn làm mốc so sánh. */
export function reynoldsRegime(reynolds: number, latticeVelocity: number, characteristicCells: number): LbmRegime {
  if (reynolds < 1) {
    return {
      label: "Stokes flow (Re < 1)",
      interpretation: "Dòng nhớt thuần — đối xứng trước/sau vật, không có wake. Quán tính không đáng kể, lực cản do nhớt quyết định.",
      benchmark: "Cd ∝ 1/Re. Trụ tròn Stokes: Cd ≈ 8π/(Re·ln(7.4/Re)); cầu: Cd = 24/Re.",
    };
  }
  if (reynolds < 40) {
    return {
      label: "Wake đối xứng ổn định (1 ≤ Re < 40)",
      interpretation: "Cặp xoáy dính đứng yên sau vật cản, vẫn đối xứng. Chưa có shedding tuần hoàn.",
      benchmark: "Trụ tròn Re=20: Cd ≈ 2.05; Re=40: Cd ≈ 1.55.",
    };
  }
  if (reynolds < 200) {
    const shedding = (0.2 * latticeVelocity) / Math.max(1, characteristicCells);
    return {
      label: "Karman vortex street (40 ≤ Re < 200)",
      interpretation: "Xoáy CW–CCW rời luân phiên. Strouhal St ≈ 0.20 → tần số shedding f = St·U/D.",
      benchmark: `Trụ tròn Re=100: Cd ≈ 1.4, St ≈ 0.16. Dự đoán f ≈ ${shedding.toExponential(2)} 1/ts.`,
    };
  }
  if (reynolds < 1000) {
    return {
      label: "Wake chuyển tiếp (200 ≤ Re < 10³)",
      interpretation: "Wake bắt đầu nhiễu loạn 3D — mô phỏng 2D ở đây chỉ giữ đúng xu hướng, không giữ đúng cấu trúc.",
      benchmark: "Trụ tròn Re=500: Cd ≈ 1.2, St ≈ 0.21.",
    };
  }
  if (reynolds < 2e5) {
    return {
      label: "Wake rối dưới hạn (10³ ≤ Re < 2·10⁵)",
      interpretation: "Lớp biên còn laminar, wake đã rối. Cd gần như không đổi theo Re trong dải này.",
      benchmark: "Trụ tròn Re ≈ 10⁴–10⁵: Cd ≈ 1.0–1.2.",
    };
  }
  return {
    label: "Trên hạn — drag crisis (Re ≥ 2·10⁵)",
    interpretation: "Lớp biên chuyển rối → điểm tách dòng lùi về sau → Cd sụt đột ngột.",
    benchmark: "Trụ tròn Re > 3·10⁵: Cd có thể xuống tới 0.3.",
  };
}

/**
 * Thống kê trường dòng + lực tại trạng thái hiện tại.
 *
 * Lưu ý hệ số: Cd = 2·Fx/(ρ·U²·D) với ρ = 1 trong LBM chuẩn hoá. Bản Aeroedu
 * gốc chia cho U²·D (thiếu hệ số 2) nên Cd nhỏ đi một nửa so với mốc sách;
 * bản này dùng đúng định nghĩa để so được với benchmark trụ tròn.
 */
export function computeLbmReport(state: LbmState, latticeVelocity: number, omega: number): LbmReport {
  const { nx, ny, solid, ux, uy, rho } = state;
  const tau = 1 / omega;
  const nu = (tau - 0.5) / 3;

  let x0 = nx, x1 = -1, y0 = ny, y1 = -1, solidCells = 0;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      if (!solid[y * nx + x]) continue;
      solidCells += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const hasObstacle = solidCells > 0;
  const bbox = hasObstacle ? { x0, y0, x1, y1 } : null;
  // D = bề dày chắn dòng (chiều vuông góc dòng) — chuẩn cho Cd/Re bluff body.
  const characteristicCells = hasObstacle ? y1 - y0 + 1 : 20;
  const reynolds = (latticeVelocity * characteristicCells) / nu;

  let maxSpeed = 0, totalSpeed = 0, fluidCount = 0;
  let maxVorticity = 0, maxPressure = -Infinity, minPressure = Infinity;
  let wakeSum = 0, wakeCount = 0;
  const wakeX0 = hasObstacle ? x1 + 2 : -1;
  const wakeX1 = hasObstacle ? Math.min(nx - 2, x1 + 32) : -1;
  const wakeY0 = hasObstacle ? Math.max(1, y0 - 5) : -1;
  const wakeY1 = hasObstacle ? Math.min(ny - 2, y1 + 5) : -1;
  for (let y = 1; y < ny - 1; y += 1) {
    for (let x = 1; x < nx - 1; x += 1) {
      const i = y * nx + x;
      if (solid[i]) continue;
      const speed = Math.hypot(ux[i], uy[i]);
      if (speed > maxSpeed) maxSpeed = speed;
      totalSpeed += speed;
      fluidCount += 1;
      const duydx = uy[y * nx + (x + 1)] - uy[y * nx + (x - 1)];
      const duxdy = ux[(y + 1) * nx + x] - ux[(y - 1) * nx + x];
      const vorticity = Math.abs((duydx - duxdy) * 0.5);
      if (vorticity > maxVorticity) maxVorticity = vorticity;
      const pressure = rho[i] - 1;
      if (pressure > maxPressure) maxPressure = pressure;
      if (pressure < minPressure) minPressure = pressure;
      if (hasObstacle && x >= wakeX0 && x <= wakeX1 && y >= wakeY0 && y <= wakeY1) {
        wakeSum += speed;
        wakeCount += 1;
      }
    }
  }
  const avgSpeed = fluidCount > 0 ? totalSpeed / fluidCount : 0;
  const wakeAvgSpeed = wakeCount > 0 ? wakeSum / wakeCount : 0;
  const wakeDeficitPct = wakeCount > 0 && latticeVelocity > 0 ? 100 - (wakeAvgSpeed / latticeVelocity) * 100 : 0;

  const { fx, fy } = hasObstacle ? momentumExchangeForces(state) : { fx: 0, fy: 0 };
  const denom = 0.5 * latticeVelocity * latticeVelocity * characteristicCells;
  const cd = denom > 0 ? fx / denom : 0;
  const cl = denom > 0 ? fy / denom : 0;

  return {
    grid: { nx, ny, totalCells: nx * ny },
    sim: { latticeVelocity, omega, tau, nu, step: state.step },
    obstacle: { solidCells, bbox, characteristicCells, coverage: solidCells / (nx * ny), hasObstacle, blockageRatio: characteristicCells / ny },
    flow: { maxSpeed, avgSpeed, wakeAvgSpeed, wakeDeficitPct, maxVorticity, maxPressure: hasObstacle || fluidCount > 0 ? maxPressure : 0, minPressure: fluidCount > 0 ? minPressure : 0 },
    forces: { fx, fy, cd, cl },
    reynolds,
    regime: reynoldsRegime(reynolds, latticeVelocity, characteristicCells),
  };
}

// ─── Chạy headless: warm-up → lấy mẫu lực → RMS + Strouhal ───────

export type LbmSolveOptions = {
  nx?: number;
  ny?: number;
  latticeVelocity?: number;
  omega?: number;
  /** Số bước chạy để dòng phát triển trước khi lấy mẫu. */
  warmupSteps?: number;
  /** Số bước lấy mẫu lực. */
  sampleSteps?: number;
  /** Lấy mẫu lực mỗi `sampleEvery` bước (MEM khá tốn). */
  sampleEvery?: number;
  /** Nhiễu khởi tạo — đặt 0 (kèm `random` tiền định) để test lặp lại được. */
  noise?: number;
  random?: () => number;
  /** Mô hình collision: "bgk" (mặc định) hoặc "mrt" cho Re cao. */
  collision?: CollisionModel;
  /** Hằng số Smagorinsky LES; null/bỏ trống = tắt. */
  smagorinsky?: number | null;
  /** Dựng vật cản trên lưới đã tạo. */
  build: (state: LbmState) => void;
};

export type LbmSolveResult = {
  state: LbmState;
  report: LbmReport;
  cdMean: number;
  cdRms: number;
  clMean: number;
  clRms: number;
  /** Strouhal St = f·D/U đo từ dao động Cl (0 nếu không thấy shedding). */
  strouhal: number;
  sheddingDetected: boolean;
  cdHistory: number[];
  clHistory: number[];
  steps: number;
};

/** Bộ sinh số tiền định (LCG) — cho test tái lập. */
export function seededRandom(seed = 1): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function solveLbm(options: LbmSolveOptions): LbmSolveResult {
  const nx = options.nx ?? 200;
  const ny = options.ny ?? 80;
  const latticeVelocity = options.latticeVelocity ?? 0.09;
  // BGK chỉ ổn định tới ~1.96; MRT chịu được omega sát 2 nên nới trần cho nó.
  const omegaCeiling = options.collision === "mrt" ? 1.9995 : OMEGA_MAX;
  const omega = Math.min(omegaCeiling, Math.max(OMEGA_MIN, options.omega ?? 1.7));
  const warmupSteps = Math.max(0, options.warmupSteps ?? 1200);
  const sampleSteps = Math.max(1, options.sampleSteps ?? 600);
  const sampleEvery = Math.max(1, options.sampleEvery ?? 4);

  const stepOptions: StepOptions = { collision: options.collision ?? "bgk", smagorinsky: options.smagorinsky ?? null };

  const state = createLbm(nx, ny);
  initLbm(state, latticeVelocity, options.noise ?? 0.01, options.random ?? Math.random);
  options.build(state);

  for (let i = 0; i < warmupSteps; i += 1) stepLbm(state, omega, latticeVelocity, stepOptions);

  // D lấy một lần từ hình học (không đổi trong khi chạy).
  let y0 = ny, y1 = -1;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      if (!state.solid[y * nx + x]) continue;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const characteristicCells = y1 >= y0 ? y1 - y0 + 1 : 20;
  const denom = 0.5 * latticeVelocity * latticeVelocity * characteristicCells;

  const cdHistory: number[] = [];
  const clHistory: number[] = [];
  for (let i = 0; i < sampleSteps; i += 1) {
    stepLbm(state, omega, latticeVelocity, stepOptions);
    if (i % sampleEvery !== 0) continue;
    const { fx, fy } = momentumExchangeForces(state);
    cdHistory.push(denom > 0 ? fx / denom : 0);
    clHistory.push(denom > 0 ? fy / denom : 0);
  }

  const mean = (values: number[]) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  const rms = (values: number[], centre: number) => (values.length > 0 ? Math.sqrt(values.reduce((sum, value) => sum + (value - centre) ** 2, 0) / values.length) : 0);
  const cdMean = mean(cdHistory);
  const clMean = mean(clHistory);
  const cdRms = rms(cdHistory, cdMean);
  const clRms = rms(clHistory, clMean);

  // Strouhal từ tần số dao động của Cl. Đếm đổi dấu trần quanh giá trị trung bình
  // thì KHÔNG dùng được: khi shedding còn yếu (ClRms ~ 0.03) nhiễu số học tự tạo
  // ra hàng loạt lần đổi dấu và St đo được nhảy loạn (đã đo: 0.296 / 0.148 /
  // 0.111 / 0.259 trên cùng bài toán ở bốn tỷ lệ chắn kênh khác nhau).
  //
  // Dùng trigger Schmitt: chỉ tính một lần chuyển khi tín hiệu đã vượt hẳn ngưỡng
  // +h rồi mới xuống dưới −h, với h = nửa RMS. Nhiễu quanh 0 không đủ biên độ để
  // lật trạng thái nên bị loại, còn dao động thật thì đếm đúng chu kỳ.
  const hysteresis = 0.5 * clRms;
  let crossings = 0;
  let sign = 0;
  for (let i = 0; i < clHistory.length; i += 1) {
    const value = clHistory[i] - clMean;
    if (sign >= 0 && value < -hysteresis) { if (sign > 0) crossings += 1; sign = -1; }
    else if (sign <= 0 && value > hysteresis) { if (sign < 0) crossings += 1; sign = 1; }
  }
  const sampledTimesteps = clHistory.length * sampleEvery;
  const frequency = sampledTimesteps > 0 ? crossings / (2 * sampledTimesteps) : 0;
  // Chỉ coi là shedding khi biên độ đủ lớn VÀ có ít nhất 2 chu kỳ trong cửa sổ.
  const sheddingDetected = clRms > 0.02 && crossings >= 4;
  const strouhal = sheddingDetected ? (frequency * characteristicCells) / latticeVelocity : 0;

  return {
    state,
    report: computeLbmReport(state, latticeVelocity, omega),
    cdMean,
    cdRms,
    clMean,
    clRms,
    strouhal,
    sheddingDetected,
    cdHistory,
    clHistory,
    steps: warmupSteps + sampleSteps,
  };
}

// ─── Xuất Markdown ───────────────────────────────────────────────

export function lbmReportToMarkdown(report: LbmReport, extra: { title?: string; generatedAt?: string; cdMean?: number; clRms?: number; strouhal?: number; siNote?: string } = {}) {
  const lines = [
    `# ${extra.title ?? "Báo cáo mô phỏng LBM D2Q9"}`,
    extra.generatedAt ? `Thời điểm: ${extra.generatedAt}` : "",
    "",
    "## Thông số mô phỏng",
    `- Lưới: **${report.grid.nx} × ${report.grid.ny}** = ${report.grid.totalCells.toLocaleString()} ô`,
    `- Vận tốc lattice U: **${report.sim.latticeVelocity.toFixed(3)}** lu/ts`,
    `- ω = **${report.sim.omega.toFixed(3)}** → τ = ${report.sim.tau.toFixed(3)}, ν = ${report.sim.nu.toFixed(5)} lu²/ts`,
    `- **Reynolds mô phỏng Re = ${report.reynolds.toFixed(1)}**`,
    `- Số bước đã chạy: ${report.sim.step.toLocaleString()}`,
    "",
    "## Vật cản",
    report.obstacle.hasObstacle
      ? `- Ô solid: **${report.obstacle.solidCells.toLocaleString()}** (${(report.obstacle.coverage * 100).toFixed(2)}% lưới)`
      : "- **Không có vật cản** (dòng tự do)",
    report.obstacle.bbox
      ? `- Hộp bao: (${report.obstacle.bbox.x0}, ${report.obstacle.bbox.y0}) → (${report.obstacle.bbox.x1}, ${report.obstacle.bbox.y1})`
      : "",
    `- Chiều dài đặc trưng D: **${report.obstacle.characteristicCells}** ô`,
    `- Tỷ lệ chắn kênh D/H: **${(report.obstacle.blockageRatio * 100).toFixed(1)}%**${report.obstacle.blockageRatio > 0.1 ? " — trên 10%, Cd đo được cao hơn giá trị không gian tự do do hiệu ứng bó dòng" : ""}`,
    "",
    "## Đặc trưng dòng chảy",
    `- Vận tốc cực đại: **${report.flow.maxSpeed.toFixed(4)}** lu/ts (${((report.flow.maxSpeed / Math.max(report.sim.latticeVelocity, 1e-6)) * 100 - 100).toFixed(0)}% so với inlet)`,
    `- Vận tốc trung bình miền fluid: ${report.flow.avgSpeed.toFixed(4)} lu/ts`,
    report.obstacle.hasObstacle
      ? `- Vận tốc trung bình wake: **${report.flow.wakeAvgSpeed.toFixed(4)}** lu/ts → hụt ${report.flow.wakeDeficitPct.toFixed(0)}% so với inlet`
      : "",
    `- Xoáy cực đại |∇×u|: ${report.flow.maxVorticity.toFixed(4)} 1/ts`,
    `- Chênh áp (ρ−1): ${report.flow.minPressure.toFixed(5)} ↔ ${report.flow.maxPressure.toFixed(5)}`,
    "",
    "## Lực (Momentum Exchange Method)",
    `- F_x = ${report.forces.fx.toFixed(4)} lu · F_y = ${report.forces.fy.toFixed(4)} lu`,
    `- **C_d = ${report.forces.cd.toFixed(3)}**${extra.cdMean !== undefined ? ` (trung bình theo thời gian: ${extra.cdMean.toFixed(3)})` : ""}`,
    `- **C_l = ${report.forces.cl.toFixed(3)}**${extra.clRms !== undefined ? ` (RMS dao động: ${extra.clRms.toFixed(3)})` : ""}`,
    extra.strouhal !== undefined && extra.strouhal > 0 ? `- Strouhal đo được: **St = ${extra.strouhal.toFixed(3)}**` : "",
    "",
    `## Chế độ dòng: ${report.regime.label}`,
    report.regime.interpretation,
    "",
    `**So sánh chuẩn:** ${report.regime.benchmark}`,
    extra.siNote ? "" : "",
    extra.siNote ? `**Quy đổi SI:** ${extra.siNote}` : "",
    "",
    "---",
    "*Số liệu ở đơn vị lattice (lu/ts). Cd/Cl là đại lượng không thứ nguyên nên dùng được trực tiếp cho tính lực SI: F = C · ½ρU²A.*",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

// ─── Bảng màu (dùng chung cho canvas UI) ─────────────────────────

export type LbmColorMode = "speed" | "vorticity" | "pressure";

/** Xanh đậm → cyan → lục → vàng → đỏ. */
export function speedColor(speed: number, max: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, speed / Math.max(max, 1e-9)));
  if (t < 0.25) { const k = t * 4; return [0, Math.round(k * 100), Math.round(120 + k * 135)]; }
  if (t < 0.5) { const k = (t - 0.25) * 4; return [0, Math.round(100 + k * 155), Math.round(255 - k * 100)]; }
  if (t < 0.75) { const k = (t - 0.5) * 4; return [Math.round(k * 255), 255, Math.round(155 - k * 155)]; }
  const k = (t - 0.75) * 4;
  return [255, Math.round(255 - k * 255), 0];
}

/** Xoáy: xanh (CW) → đen → đỏ (CCW). */
export function vorticityColor(curl: number, max: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, curl / Math.max(max, 1e-9)));
  if (t > 0) return [Math.round(255 * t), Math.round(60 * t), Math.round(60 * t)];
  return [Math.round(60 * -t), Math.round(60 * -t), Math.round(255 * -t)];
}

/** Áp suất từ ρ−1 (khuếch đại ×50). */
export function pressureColor(rho: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, (rho - 1) * 50));
  if (t > 0) return [Math.round(80 + t * 175), Math.round(80 + t * 100), 80];
  return [40, Math.round(60 + -t * 100), Math.round(80 + -t * 175)];
}
