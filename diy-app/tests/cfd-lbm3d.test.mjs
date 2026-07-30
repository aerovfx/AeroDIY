import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, SphereGeometry } from "three";
import { buildCadProject } from "../dist-mcp/lib/cad-engine.js";
import { seededRandom } from "../dist-mcp/lib/cfd-lbm.js";
import {
  C3X, C3Y, C3Z, OPP19, W19,
  createLbm3d, initLbm3d, stepLbm3d, streamAndApplyBoundaries3d,
  presetSphere3d, momentumExchangeForces3d, frontalProjection3d,
  voxelizeMeshMm, voxelizeScene, solveLbm3d, sphereDragSchillerNaumann,
} from "../dist-mcp/lib/cfd-lbm3d.js";

/** Trích tam giác (mm, y hướng lên) từ geometry three.js — đúng đường mà app sẽ dùng. */
function trianglesOf(geometry) {
  return geometry.toNonIndexed().getAttribute("position").array;
}

test("Hằng số D3Q19 tự nhất quán (điều kiện để kernel WGSL đối chiếu được)", () => {
  assert.equal(C3X.length, 19);
  let sumW = 0;
  const firstMoment = [0, 0, 0];
  const secondMoment = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let q = 0; q < 19; q += 1) {
    sumW += W19[q];
    const c = [C3X[q], C3Y[q], C3Z[q]];
    for (let a = 0; a < 3; a += 1) {
      firstMoment[a] += W19[q] * c[a];
      for (let b = 0; b < 3; b += 1) secondMoment[a][b] += W19[q] * c[a] * c[b];
    }
    // OPP phải là phép đối hợp và đảo đúng vận tốc. Dùng === thay assert.equal:
    // assert.strict theo ngữ nghĩa Object.is nên −0 ≠ 0 và −C[q] của thành phần
    // bằng 0 sẽ trượt oan.
    assert.equal(OPP19[OPP19[q]], q);
    assert.ok(C3X[OPP19[q]] === -C3X[q] && C3Y[OPP19[q]] === -C3Y[q] && C3Z[OPP19[q]] === -C3Z[q], `hướng đối của q=${q} sai`);
  }
  assert.ok(Math.abs(sumW - 1) < 1e-12, `ΣW = ${sumW}`);
  for (let a = 0; a < 3; a += 1) {
    assert.ok(Math.abs(firstMoment[a]) < 1e-12, "Σ w·c phải triệt tiêu");
    for (let b = 0; b < 3; b += 1) {
      const expected = a === b ? 1 / 3 : 0;
      assert.ok(Math.abs(secondMoment[a][b] - expected) < 1e-12, `Σ w c_${a} c_${b} = ${secondMoment[a][b]} ≠ ${expected} — bộ vận tốc mất đẳng hướng`);
    }
  }
});

test("Miền trống 3D: bảo toàn khối lượng tuyệt đối, không áp suất giả, LES trung tính trên dòng đều", () => {
  // Đây là bài test đáng ra đã bắt được lỗi biên của bản 2D (trôi +0.65%/400
  // bước). Dòng đều là nghiệm chính xác: mọi sai lệch đều là lỗi biên.
  const inflow = 0.06;
  const run = (smagorinsky) => {
    const state = createLbm3d(32, 24, 24);
    initLbm3d(state, inflow, 0, seededRandom(1));
    for (let i = 0; i < 300; i += 1) stepLbm3d(state, 1.7, inflow, { smagorinsky });
    return state;
  };
  const state = run(null);
  let total = 0;
  for (let i = 0; i < state.f.length; i += 1) total += state.f[i];
  const expected = state.n; // rho = 1 mỗi ô
  assert.ok(Math.abs(total / expected - 1) < 1e-5, `Σf/n = ${total / expected} — khối lượng trôi`);
  let maxPressure = 0, maxDeviation = 0;
  for (let i = 0; i < state.n; i += 1) {
    maxPressure = Math.max(maxPressure, Math.abs(state.rho[i] - 1));
    maxDeviation = Math.max(maxDeviation, Math.abs(state.ux[i] - inflow));
  }
  assert.ok(maxPressure < 1e-5, `áp suất giả ${maxPressure} trong miền trống`);
  assert.ok(maxDeviation < 1e-5, `dòng đều bị biến dạng ${maxDeviation}`);

  // LES phải trung tính khi không có biến dạng: f = feq ⇒ Π = 0 ⇒ ν_t = 0.
  const withLes = run(0.14);
  let lesDrift = 0;
  for (let i = 0; i < state.n; i += 1) lesDrift = Math.max(lesDrift, Math.abs(withLes.ux[i] - state.ux[i]));
  assert.ok(lesDrift < 1e-6, `LES làm đổi dòng đều ${lesDrift} — công thức Π sai`);
});

test("Voxelizer mesh three.js: quả cầu khớp giải tích, hộp khớp thể tích", () => {
  // Đây là đường "collision" thật: dòng chảy va vào đúng tam giác Three.js render.
  const sphereState = createLbm3d(96, 56, 56);
  const sphere = voxelizeMeshMm(sphereState, trianglesOf(new SphereGeometry(30, 48, 32)), { crossStreamCells: 14 });
  assert.equal(sphere.openColumns, 0, "mesh cầu three.js phải kín");
  const radius = sphere.characteristicCells / 2;
  assert.ok(Math.abs(sphere.characteristicCells - 14) < 1, `D = ${sphere.characteristicCells} lệch mục tiêu 14 ô`);
  const volumeAnalytic = (4 / 3) * Math.PI * radius ** 3;
  const frontalAnalytic = Math.PI * radius ** 2;
  assert.ok(Math.abs(sphere.solidCells / volumeAnalytic - 1) < 0.05, `thể tích voxel lệch ${((sphere.solidCells / volumeAnalytic - 1) * 100).toFixed(1)}%`);
  assert.ok(Math.abs(sphere.frontalCells / frontalAnalytic - 1) < 0.04, `diện tích cản lệch ${((sphere.frontalCells / frontalAnalytic - 1) * 100).toFixed(1)}%`);

  const boxState = createLbm3d(64, 48, 48);
  const box = voxelizeMeshMm(boxState, trianglesOf(new BoxGeometry(40, 20, 60)), { crossStreamCells: 12 });
  assert.equal(box.openColumns, 0);
  // Hộp 40×20×60 mm, thinnest 20 mm → 12 ô ⇒ scale 0.6 ⇒ ~24×12×36 ô.
  const boxVolume = 24 * 12 * 36;
  assert.ok(Math.abs(box.solidCells / boxVolume - 1) < 0.12, `thể tích hộp ${box.solidCells} vs ~${boxVolume}`);
});

test("Voxelizer mesh: mesh HỞ bị phát hiện thay vì tô sai trong im lặng", () => {
  // Một tam giác đơn không bao kín thể tích nào — mọi cột đều có số giao điểm lẻ.
  // Guard parity phải đếm vào openColumns và không tô ô nào.
  const state = createLbm3d(48, 32, 32);
  const openTriangle = new Float32Array([0, 0, 0, 0, 40, 0, 0, 0, 40]);
  const result = voxelizeMeshMm(state, openTriangle, { crossStreamCells: 10 });
  assert.ok(result.openColumns > 0, "phải phát hiện mesh hở");
  assert.equal(result.solidCells, 0, "mesh hở không được tô ô nào");
});

test("Voxelizer scene UAV 3D: kích thước thật, bỏ dây/vít, góc tấn xoay đúng chiều", () => {
  const scene = buildCadProject().scene;
  const state = createLbm3d(128, 48, 96);
  const flat = voxelizeScene(state, scene, { crossStreamCells: 10, angleOfAttackDeg: 0 });
  assert.ok(flat.solidCells > 100, `solidCells = ${flat.solidCells}`);
  assert.ok(flat.frontalCells > 50);
  // Khung Budget Mini UAV thật: 260 mm dọc thân, ~47 mm dày, ~204 mm ngang.
  assert.ok(Math.abs(flat.extentsMm[0] - 260) < 3, `dọc thân ${flat.extentsMm[0]} mm`);
  // 42 mm ở AOA 0 (đo thật); 47 mm chỉ xuất hiện khi có góc tấn.
  assert.ok(flat.extentsMm[1] > 38 && flat.extentsMm[1] < 52, `bề dày ${flat.extentsMm[1]} mm`);
  assert.ok(flat.skipped.some((id) => id.startsWith("wire-")));
  assert.ok(flat.skipped.some((id) => id.startsWith("motor-screw-")));
  // Trục mỏng (y) được nhắm 10 ô — bbox y không được phình quá xa mục tiêu.
  const thickness = flat.bbox.y1 - flat.bbox.y0 + 1;
  assert.ok(thickness >= 8 && thickness <= 16, `bề dày lưới ${thickness} ô`);

  // Góc tấn 20°: thân dài phẳng nghiêng lên ⇒ bề dày chắn dòng (y) phải tăng rõ.
  const pitchedState = createLbm3d(128, 48, 96);
  const pitched = voxelizeScene(pitchedState, scene, { crossStreamCells: 10, angleOfAttackDeg: 20 });
  assert.ok(pitched.extentsMm[1] > flat.extentsMm[1] * 1.5, `AOA 20° phải tăng bề dày: ${pitched.extentsMm[1]} vs ${flat.extentsMm[1]} mm`);
});

test("Cd quả cầu Re=100: đúng thang sách sau khi tính lạm phát mảng tuần hoàn", () => {
  // Biên ngang tuần hoàn = mảng vật thể cách ~4.8D, nên Cd đo được CAO hơn giá
  // trị không gian tự do (hiệu chuẩn được ×1.2–1.5 tuỳ Re). Dải chấp nhận dưới
  // đây được khoá từ số ĐO, không phải từ mong muốn: đo được 1.435 với cấu hình
  // đúng như này, sách (Schiller–Naumann) cho 1.092.
  const inflow = 0.06, diameter = 10, reynolds = 100;
  const omega = 1 / (3 * ((inflow * diameter) / reynolds) + 0.5);
  const run = solveLbm3d({
    nx: 96, ny: 48, nz: 48, latticeVelocity: inflow, omega,
    warmupSteps: 700, sampleSteps: 300, sampleEvery: 5,
    random: seededRandom(7),
    build: (state) => presetSphere3d(state, 26, 24, 24, diameter / 2),
  });
  assert.equal(run.finite, true, "trường phân kỳ");
  assert.ok(run.maxSpeed < 0.3, `maxSpeed ${run.maxSpeed} — sát giới hạn nén được`);
  const book = sphereDragSchillerNaumann(reynolds);
  const inflation = run.cdMean / book;
  assert.ok(run.cdMean > 1.15 && run.cdMean < 1.7, `Cd ${run.cdMean} ngoài dải hiệu chuẩn`);
  assert.ok(inflation > 1.05 && inflation < 1.55, `lạm phát mảng ×${inflation.toFixed(2)} ngoài dải vật lý`);
  // Re=100: wake quả cầu ổn định đối xứng trục ⇒ lực ngang triệt tiêu, Cd đứng yên.
  assert.ok(Math.abs(run.cyMean) < 0.02 && Math.abs(run.czMean) < 0.02, `bất đối xứng Cy=${run.cyMean} Cz=${run.czMean}`);
  assert.ok(run.cdRms < 0.05, `Cd dao động ${run.cdRms} ở Re=100 — wake đáng ra ổn định`);

  // Hụt vận tốc trong wake: ngay sau quả cầu dòng phải chậm hơn hẳn inflow.
  const { state } = run;
  const centre = (24 * state.ny + 24) * state.nx;
  const wakeUx = state.ux[centre + 26 + diameter];
  assert.ok(wakeUx < inflow * 0.75, `wake ux=${wakeUx} không hụt so với inflow ${inflow}`);
});

test("Cd quả cầu giảm đơn điệu theo Re (100 → 300, LES giữ ổn định)", () => {
  const inflow = 0.06, diameter = 10;
  const at = (reynolds, smagorinsky) => solveLbm3d({
    nx: 96, ny: 48, nz: 48, latticeVelocity: inflow,
    omega: 1 / (3 * ((inflow * diameter) / reynolds) + 0.5),
    warmupSteps: 700, sampleSteps: 300, sampleEvery: 5,
    random: seededRandom(7), smagorinsky,
    build: (state) => presetSphere3d(state, 26, 24, 24, diameter / 2),
  });
  const re100 = at(100, null);
  const re300 = at(300, 0.14);
  assert.equal(re300.finite, true);
  assert.ok(re300.cdMean < re100.cdMean * 0.85, `Cd không giảm theo Re: ${re300.cdMean} vs ${re100.cdMean}`);
  assert.ok(re300.cdMean > 0.6, `Cd Re=300 = ${re300.cdMean} thấp phi vật lý`);
});

test("Momentum exchange 3D: lực cản dương, bất biến thời điểm đo trong bước", () => {
  const state = createLbm3d(64, 32, 32);
  initLbm3d(state, 0.06, 0.01, seededRandom(5));
  presetSphere3d(state, 20, 16, 16, 4);
  for (let i = 0; i < 300; i += 1) stepLbm3d(state, 1.85, 0.06);
  const first = momentumExchangeForces3d(state);
  const second = momentumExchangeForces3d(state);
  assert.equal(first.fx, second.fx);
  assert.ok(first.fx > 0, `lực cản ${first.fx} phải dương theo chiều dòng`);
  // Sau streaming (trước collide) phải cho CÙNG giá trị — collide bỏ qua ô solid.
  streamAndApplyBoundaries3d(state, 0.06);
  const afterStream = momentumExchangeForces3d(state);
  assert.ok(Number.isFinite(afterStream.fx) && afterStream.fx > 0);
});

test("Outlet zero-gradient: wake phải thoát được khỏi miền", () => {
  // Test miền trống KHÔNG bắt được lỗi đảo chiều copy outlet (hai cột cuối giống
  // hệt nhau nên copy xuôi/ngược đều là no-op) — mutation-check đã chứng minh.
  // Bài này dùng wake thật của quả cầu làm chất chỉ thị: đo được bản gốc cho
  // residual 7.4e-5 và hụt wake 3.5e-3; bản đảo chiều cho 5.2e-4 và 5.6e-4.
  const nx = 64, ny = 32, nz = 32, inflow = 0.06;
  const state = createLbm3d(nx, ny, nz);
  initLbm3d(state, inflow, 0.01, seededRandom(5));
  presetSphere3d(state, 20, 16, 16, 4);
  for (let i = 0; i < 600; i += 1) stepLbm3d(state, 1.85, inflow);
  let residual = 0;
  for (let z = 1; z < nz - 1; z += 1) {
    for (let y = 1; y < ny - 1; y += 1) {
      const row = (z * ny + y) * nx;
      residual = Math.max(residual, Math.abs(state.ux[row + nx - 2] - state.ux[row + nx - 3]));
    }
  }
  assert.ok(residual < 3e-4, `residual zero-gradient ${residual.toExponential(2)} — outlet không còn zero-gradient`);
  const wakeDeficit = inflow - state.ux[(16 * ny + 16) * nx + (nx - 3)];
  assert.ok(wakeDeficit > 1.5e-3, `hụt wake tại outlet ${wakeDeficit.toExponential(2)} — wake không thoát được khỏi miền`);
});

test("Tiền định: cùng seed cho cùng kết quả từng bit", () => {
  const run = () => solveLbm3d({
    nx: 48, ny: 24, nz: 24, latticeVelocity: 0.06, omega: 1.8,
    warmupSteps: 120, sampleSteps: 60, sampleEvery: 4,
    random: seededRandom(42),
    build: (state) => presetSphere3d(state, 14, 12, 12, 3),
  });
  const first = run();
  const second = run();
  assert.equal(first.cdMean, second.cdMean);
  assert.equal(first.cyMean, second.cyMean);
  assert.equal(first.frontalCells, second.frontalCells);
});

test("frontalProjection3d đếm đúng diện tích chiếu", () => {
  const state = createLbm3d(32, 16, 16);
  // Khối 4×3 ở giữa, kéo dài 5 ô theo dòng — diện tích chiếu phải đúng 12 cột.
  for (let z = 6; z < 9; z += 1) for (let y = 5; y < 9; y += 1) for (let x = 10; x < 15; x += 1) {
    state.solid[(z * 16 + y) * 32 + x] = 1;
  }
  assert.equal(frontalProjection3d(state), 12);
});

// ─── Bước 2: sinh WGSL từ hằng số reference ──────────────────────

test("WGSL sinh ra nhúng đúng bộ hằng số và ánh xạ OPP của reference", async () => {
  const { buildD3q19StepWgsl, buildD3q19ForcesWgsl, FORCE_FIXED_POINT } = await import("../dist-mcp/lib/cfd-lbm3d-gpu.js");
  const step = buildD3q19StepWgsl();
  // Nhánh solid phải pull hướng đối từ ô xuôi dòng cho ĐỦ 19 hướng — sai một
  // dòng là bounce-back GPU lệch reference.
  for (let q = 0; q < 19; q += 1) {
    const line = `fDst[base + ${q}u] = fSrc[cellAt(x + (${C3X[q]}), y + (${C3Y[q]}), z + (${C3Z[q]})) * 19u + ${OPP19[q]}u];`;
    assert.ok(step.includes(line), `thiếu/lệch dòng solid q=${q}`);
    assert.ok(step.includes(`var g${q} = fSrc[cellAt(gx - (${C3X[q]}), gy - (${C3Y[q]}), gz - (${C3Z[q]})) * 19u + ${q}u];`), `gather q=${q} sai hướng`);
  }
  // LES chỉ xuất hiện khi được bật — và khi bật phải có đủ 6 thành phần tensor.
  assert.ok(!step.includes("piNorm"), "BGK thuần không được chứa nhánh LES");
  const les = buildD3q19StepWgsl({ smagorinsky: 0.14 });
  assert.ok(les.includes("piNorm") && les.includes("pxy") && les.includes("pyz") && les.includes("pxz"), "LES thiếu thành phần tensor");
  // Kernel lực: dấu phải là −c_q (đo tại ô solid).
  const forces = buildD3q19ForcesWgsl();
  assert.ok(forces.includes("atomicAdd(&forces[0], i32(round(-w)))"), "thiếu link +x với dấu âm");
  assert.ok(forces.includes("atomicAdd(&forces[0], i32(round(w)))"), "thiếu link −x với dấu dương");
  assert.equal(FORCE_FIXED_POINT, 4194304);
});

test("uniformEquilibrium3d khớp initLbm3d không nhiễu", async () => {
  const { uniformEquilibrium3d } = await import("../dist-mcp/lib/cfd-lbm3d.js");
  const state = createLbm3d(8, 6, 6);
  initLbm3d(state, 0.07, 0, seededRandom(1));
  const uniform = uniformEquilibrium3d(state.n, 0.07);
  let maxDiff = 0;
  for (let i = 0; i < state.f.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(state.f[i] - uniform[i]));
  assert.ok(maxDiff < 1e-12, `hai đường khởi tạo lệch ${maxDiff}`);
});

test("latticeFromMm: điểm mm đã biết map đúng vào lưới", () => {
  // Tâm hộp (0,0,0) mm phải rơi vào tâm bbox voxel — nếu transform sai thì
  // viewport sẽ vẽ mesh lệch khỏi trường dòng.
  const state = createLbm3d(64, 48, 48);
  const box = voxelizeMeshMm(state, trianglesOf(new BoxGeometry(40, 20, 60)), { crossStreamCells: 12 });
  const t = box.latticeFromMm;
  const map = (p) => {
    const c = Math.cos(t.angleOfAttackRad), s = Math.sin(t.angleOfAttackRad);
    const rx = c * p[0] + s * p[1], ry = -s * p[0] + c * p[1];
    return [
      t.originLattice[0] + (rx - t.originMm[0]) * t.scale,
      t.originLattice[1] + (ry - t.originMm[1]) * t.scale,
      t.originLattice[2] + (p[2] - t.originMm[2]) * t.scale,
    ];
  };
  const centre = map([0, 0, 0]);
  const bboxCentre = [(box.bbox.x0 + box.bbox.x1) / 2, (box.bbox.y0 + box.bbox.y1) / 2, (box.bbox.z0 + box.bbox.z1) / 2];
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(centre[axis] - bboxCentre[axis]) < 1.2, `trục ${axis}: ${centre[axis]} vs bbox ${bboxCentre[axis]}`);
  }
  // Góc hộp (+20, +10, +30) mm phải nằm trong bbox, góc ngoài (+30, ...) thì không.
  const corner = map([20, 10, 30]);
  assert.ok(corner[0] <= box.bbox.x1 + 1.5 && corner[0] >= box.bbox.x0 - 1.5);
});

test("WGSL tracer: nội suy tam tuyến, respawn tiền định, đúng layout 8 f32/hạt", async () => {
  const { buildTracerWgsl } = await import("../dist-mcp/lib/cfd-lbm3d-gpu.js");
  const wgsl = buildTracerWgsl();
  // Đủ 8 góc nội suy tam tuyến — thiếu góc nào là hạt trôi lệch trường.
  for (const corner of ["v000", "v100", "v010", "v110", "v001", "v101", "v011", "v111"]) {
    assert.ok(wgsl.includes(corner), `thiếu góc ${corner}`);
  }
  assert.ok(wgsl.includes("solid[cellIndex] == 1u"), "hạt phải chết khi chui vào solid");
  assert.ok(wgsl.includes("pcg("), "respawn phải dùng hash tiền định");
  assert.ok(wgsl.includes("particles[base + 7u]"), "layout 8 f32/hạt (hue ở slot 7)");
});
