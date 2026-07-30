import assert from "node:assert/strict";
import test from "node:test";
import { buildCadProject } from "../dist-mcp/lib/cad-engine.js";
import { runLbmValidation } from "../dist-mcp/lib/cfd-engine.js";
import {
  createLbm,
  deriveLatticeSetup,
  initLbm,
  lbmReportToMarkdown,
  momentumExchangeForces,
  presetAirfoil,
  presetCylinder,
  presetTeardrop,
  rasterizeScene,
  seededRandom,
  solveLbm,
  stepLbm,
  computeLbmReport,
  LBM_SHAPES,
  createScalarField,
  stepScalar,
  scalarOmega,
  applyTransverseImpulse,
  sheddingTriggerRegion,
} from "../dist-mcp/lib/cfd-lbm.js";

/** Dựng solver ở đúng Reynolds mong muốn cho một vật cản có bề dày D ô. */
function omegaForReynolds(latticeVelocity, characteristicCells, reynolds) {
  const nu = (latticeVelocity * characteristicCells) / reynolds;
  return 1 / (3 * nu + 0.5);
}

test("LBM giữ dòng đều khi miền trống: không tạo lực và không phân kỳ", () => {
  const state = createLbm(80, 40);
  initLbm(state, 0.1, 0, seededRandom(1));
  for (let i = 0; i < 300; i += 1) stepLbm(state, 1.7, 0.1);
  const report = computeLbmReport(state, 0.1, 1.7);
  assert.equal(report.obstacle.hasObstacle, false);
  assert.equal(report.forces.fx, 0);
  assert.equal(report.forces.cd, 0);
  // Dòng đều: vận tốc trung bình bám sát inlet, không có xoáy đáng kể.
  assert.ok(Math.abs(report.flow.avgSpeed - 0.1) < 0.01, `avgSpeed ${report.flow.avgSpeed}`);
  assert.ok(report.flow.maxSpeed < 0.15, `maxSpeed ${report.flow.maxSpeed}`);
  assert.ok(Number.isFinite(report.flow.maxVorticity));
});

test("Biên trên/dưới bảo toàn khối lượng và không sinh áp suất giả", () => {
  // Đây là bài test đáng ra phải bắt được lỗi biên gốc (port từ Aeroedu): code cũ
  // gán hướng ĐÃ BIẾT bằng hướng CHƯA BIẾT (cuộn từ tường đối diện), làm khối
  // lượng trôi +0.65% sau 400 bước và sinh áp suất 0.031 trong kênh TRỐNG — gấp
  // đôi thang điểm dừng vật lý.
  const nx = 60, ny = 30, u = 0.1;
  const state = createLbm(nx, ny);
  initLbm(state, u, 0, seededRandom(1));
  const total = () => {
    let sum = 0;
    for (let i = 0; i < state.f.length; i += 1) sum += state.f[i];
    return sum;
  };
  const before = total();
  for (let i = 0; i < 400; i += 1) stepLbm(state, 1.7, u);
  const drift = Math.abs(total() / before - 1);
  assert.ok(drift < 1e-4, `khối lượng trôi ${(drift * 100).toFixed(3)}% trong kênh trống`);

  // Dòng đều là nghiệm chính xác: miền không vật cản thì áp suất phải phẳng.
  let maxPressure = 0;
  for (let i = 0; i < state.n; i += 1) maxPressure = Math.max(maxPressure, Math.abs(state.rho[i] - 1));
  const stagnationScale = 1.5 * u * u;
  assert.ok(maxPressure < stagnationScale * 0.2, `áp suất giả ${maxPressure.toFixed(5)} so với thang ${stagnationScale.toFixed(5)}`);

  // Biên phải là SLIP (far-field), không phải no-slip: vận tốc dọc sát tường phải
  // giữ gần đúng inlet, nếu là no-slip thì nó tụt về ~0 và tạo lớp biên giả.
  let wallSpeed = 0;
  for (let x = 10; x < nx - 10; x += 1) wallSpeed += state.ux[x];
  wallSpeed /= nx - 20;
  assert.ok(Math.abs(wallSpeed - u) < 0.02 * u, `vận tốc sát tường ${wallSpeed.toFixed(4)} lệch khỏi inlet ${u} — biên đang là no-slip?`);
});

test("Cd của trụ tròn khớp mốc sách khi tỷ lệ chắn kênh nhỏ", () => {
  // Trụ tròn Re=100, không gian tự do: Cd ≈ 1.4 (Tritton, Schlichting).
  // Dùng lưới cao để tỷ lệ chắn ~8% → sai lệch do bó dòng còn nhỏ.
  const latticeVelocity = 0.09;
  const diameter = 20;
  const solve = solveLbm({
    nx: 320,
    ny: 210,
    latticeVelocity,
    omega: omegaForReynolds(latticeVelocity, diameter, 100),
    warmupSteps: 3500,
    sampleSteps: 1500,
    sampleEvery: 6,
    random: seededRandom(7),
    build: (state) => presetCylinder(state, 80, 105, diameter / 2),
  });
  assert.ok(solve.report.obstacle.blockageRatio < 0.1, `blockage ${solve.report.obstacle.blockageRatio}`);
  assert.ok(Math.abs(solve.cdMean - 1.4) < 0.25, `Cd ${solve.cdMean} lệch quá xa 1.4`);
  // Trụ tròn đối xứng: lực ngang trung bình phải triệt tiêu.
  assert.ok(Math.abs(solve.clMean) < 0.1, `Cl ${solve.clMean}`);
});

test("Karman vortex street xuất hiện và Strouhal khớp mốc thực nghiệm", () => {
  // Đo St ở Re=200 chứ không phải Re=100, và trên lưới chắn kênh 12.5% thay vì
  // 21%. Lý do: ở Re=100 với chắn kênh cao, shedding còn yếu (clRms≈0.03) nên
  // cả St lẫn tương quan clRms/cdRms đều bị nhiễu số học và transient chậm của Cd
  // lấn át — đo được St nhảy 0.296/0.148/0.111/0.259 trên bốn cỡ lưới của cùng
  // một bài toán. Ở Re=200 tín hiệu sạch: clRms gấp ~4 lần cdRms.
  const latticeVelocity = 0.09;
  const diameter = 20;
  const solve = solveLbm({
    nx: 300,
    ny: 160,
    latticeVelocity,
    omega: omegaForReynolds(latticeVelocity, diameter, 200),
    warmupSteps: 4000,
    sampleSteps: 3000,
    sampleEvery: 4,
    random: seededRandom(7),
    collision: "mrt",
    build: (state) => presetCylinder(state, 75, 80, diameter / 2),
  });
  assert.equal(solve.sheddingDetected, true);
  // St thực nghiệm cho trụ tròn ở Re=200 ≈ 0.19.
  assert.ok(Math.abs(solve.strouhal - 0.19) < 0.04, `St ${solve.strouhal} lệch quá xa 0.19`);
  // Lực ngang dao động ở tần số shedding, lực cản ở tần số kép và biên độ nhỏ hơn.
  assert.ok(solve.clRms > solve.cdRms * 2, `clRms ${solve.clRms} phải trội rõ so với cdRms ${solve.cdRms}`);
  assert.equal(solve.report.regime.label.startsWith("Karman"), true);
});

test("Re thấp cho wake ổn định, không shedding", () => {
  const latticeVelocity = 0.09;
  const diameter = 20;
  const solve = solveLbm({
    nx: 200,
    ny: 96,
    latticeVelocity,
    omega: omegaForReynolds(latticeVelocity, diameter, 20),
    warmupSteps: 3000,
    sampleSteps: 1500,
    sampleEvery: 5,
    random: seededRandom(3),
    build: (state) => presetCylinder(state, 50, 48, diameter / 2),
  });
  assert.equal(solve.sheddingDetected, false);
  assert.equal(solve.strouhal, 0);
  // Shedding thể hiện ở lực NGANG, không phải lực cản: ở Re=20 clRms phải ~0.
  // (Bản đầu tôi canh cdRms — sai thước đo: cdRms còn chứa transient khuếch tán
  // chậm, đo được 0.054 ở chắn kênh 21% và 0.016 ở 8.3% dù wake hoàn toàn ổn định.)
  assert.ok(solve.clRms < 0.01, `Re=20 không được có dao động ngang, clRms ${solve.clRms}`);
  // Re=20 cho Cd lớn hơn Re=100 (chế độ nhớt trội).
  assert.ok(solve.cdMean > 1.8, `Cd ${solve.cdMean}`);
});

test("Thân thuôn có lực cản nhỏ hơn trụ tròn cùng bề dày", () => {
  const latticeVelocity = 0.09;
  const thickness = 16;
  const shared = {
    nx: 240,
    ny: 120,
    latticeVelocity,
    omega: omegaForReynolds(latticeVelocity, thickness, 150),
    warmupSteps: 2500,
    sampleSteps: 1500,
    sampleEvery: 5,
    random: seededRandom(11),
  };
  const bluff = solveLbm({ ...shared, build: (state) => presetCylinder(state, 60, 60, thickness / 2) });
  const streamlined = solveLbm({ ...shared, build: (state) => presetTeardrop(state, 60, 60, 26, thickness / 2) });
  assert.ok(
    streamlined.cdMean < bluff.cdMean,
    `thân thuôn Cd ${streamlined.cdMean} phải nhỏ hơn trụ tròn Cd ${bluff.cdMean}`,
  );
});

test("Góc tấn dương sinh lực nâng dương và tăng theo góc", () => {
  const latticeVelocity = 0.09;
  const run = (deg) => solveLbm({
    nx: 240,
    ny: 120,
    latticeVelocity,
    omega: 1.85,
    warmupSteps: 2000,
    sampleSteps: 1200,
    sampleEvery: 5,
    random: seededRandom(3),
    build: (state) => presetAirfoil(state, 60, 60, 22, 7, (deg * Math.PI) / 180),
  });
  // Trục y của lưới hướng xuống, nên lực nâng (lên) là -Cl_lattice.
  const liftAt = (deg) => -run(deg).clMean;
  const neutral = liftAt(0);
  const low = liftAt(6);
  const high = liftAt(12);
  assert.ok(Math.abs(neutral) < 0.1, `Cl ở 0° phải ~0, được ${neutral}`);
  assert.ok(low > 0.3, `Cl ở 6° phải dương rõ rệt, được ${low}`);
  assert.ok(high > low, `Cl phải tăng theo góc tấn: 12° ${high} vs 6° ${low}`);
});

test("Momentum exchange không phụ thuộc thời điểm đo trong bước", () => {
  const state = createLbm(160, 80);
  initLbm(state, 0.09, 0.01, seededRandom(5));
  presetCylinder(state, 40, 40, 8);
  for (let i = 0; i < 800; i += 1) stepLbm(state, 1.8, 0.09);
  const first = momentumExchangeForces(state);
  const second = momentumExchangeForces(state);
  assert.equal(first.fx, second.fx);
  // Lực cản phải dương (theo chiều dòng).
  assert.ok(first.fx > 0, `fx ${first.fx}`);
});

test("deriveLatticeSetup khớp Re khi được, và báo rõ khi phải kẹp omega", () => {
  // Re thấp: khớp chính xác.
  const matched = deriveLatticeSetup({ velocityMs: 0.5, characteristicLengthM: 0.01, characteristicCells: 16 });
  assert.equal(matched.clamped, false);
  assert.ok(Math.abs(matched.reynoldsLattice - matched.reynoldsPhysical) / matched.reynoldsPhysical < 0.01);
  assert.ok(matched.omega > 0.4 && matched.omega < 1.96);

  // Re của UAV thực: vượt dải ổn định → kẹp và nói rõ.
  const clamped = deriveLatticeSetup({ velocityMs: 15, characteristicLengthM: 0.045, characteristicCells: 13 });
  assert.equal(clamped.clamped, true);
  assert.ok(clamped.reynoldsPhysical > 40000);
  assert.ok(clamped.reynoldsLattice < clamped.reynoldsPhysical);
  assert.match(clamped.note, /vượt dải ổn định/);
});

test("rasterizeScene chiếu hình học CAD lên lưới và bỏ chi tiết dưới cỡ ô", () => {
  const project = buildCadProject();
  const state = createLbm(240, 120);
  const raster = rasterizeScene(state, project.scene, { plane: "side", crossStreamCells: 12 });
  assert.ok(raster.solidCells > 0);
  assert.ok(raster.usedPrimitives > 5);
  assert.ok(raster.bbox);
  // Bề dày chắn dòng phải sát mục tiêu 12 ô.
  const thickness = raster.bbox.y1 - raster.bbox.y0 + 1;
  assert.ok(Math.abs(thickness - 12) <= 3, `bề dày ${thickness} ô`);
  // Bóng nằm gọn trong miền.
  assert.ok(raster.bbox.x0 >= 0 && raster.bbox.x1 < 240);
  assert.ok(raster.bbox.y0 >= 0 && raster.bbox.y1 < 120);
  // Dây và vít bị loại khỏi lưới.
  assert.ok(raster.skipped.some((id) => id.startsWith("wire-")));
  assert.ok(raster.skipped.some((id) => id.startsWith("motor-screw-")));
  // Kích thước thật của khung UAV mặc định là 260 mm dọc thân.
  assert.ok(Math.abs(raster.streamwiseMm - 260) < 1, `streamwise ${raster.streamwiseMm}`);
  // Mặt bằng cho bóng rộng hơn mặt cạnh.
  const topState = createLbm(240, 120);
  const top = rasterizeScene(topState, project.scene, { plane: "top", crossStreamCells: 12 });
  assert.ok(top.crossStreamMm > raster.crossStreamMm);
});

test("rasterizeScene xoay bóng theo góc tấn", () => {
  const project = buildCadProject();
  const flat = rasterizeScene(createLbm(240, 120), project.scene, { angleOfAttackDeg: 0 });
  const pitched = rasterizeScene(createLbm(240, 120), project.scene, { angleOfAttackDeg: 20 });
  // Nghiêng 20° làm hình chiếu dọc dòng ngắn lại và bóng dày lên.
  assert.ok(pitched.streamwiseMm < flat.streamwiseMm, `${pitched.streamwiseMm} vs ${flat.streamwiseMm}`);
  assert.ok(pitched.crossStreamMm > flat.crossStreamMm, `${pitched.crossStreamMm} vs ${flat.crossStreamMm}`);
});

test("runLbmValidation đo được Cd/Cl trên dự án UAV mặc định", () => {
  const project = buildCadProject();
  const result = runLbmValidation(project, { velocityMs: 15, angleOfAttackDeg: 0, preset: "quick", seed: 7 });
  assert.equal(result.mode, "CFD-LBM");
  assert.equal(result.domain, "aerial");
  assert.equal(result.fidelity, "resolved-2d");
  assert.equal(result.plane, "side");
  assert.equal(result.checks.length, 7);
  // Cd đo được phải nằm trong dải vật lý của một bluff body.
  assert.ok(result.measured.dragCoefficient > 0.2 && result.measured.dragCoefficient < 3, `Cd ${result.measured.dragCoefficient}`);
  assert.ok(result.measured.estimatedDragN > 0);
  // Re thực của UAV 15 m/s vượt xa dải lưới → phải báo đã kẹp.
  assert.equal(result.reynolds.clamped, true);
  assert.ok(result.reynolds.physical > result.reynolds.simulated);
  // Dây/vít không được đưa vào lưới.
  assert.ok(result.geometry.skippedPrimitives.length > 0);
  assert.ok(result.geometry.frontalAreaM2 > 0);
  assert.match(result.disclaimer, /không dùng làm số liệu chứng nhận/);
});

test("runLbmValidation tiền định với cùng seed và tăng lực cản theo góc tấn", () => {
  const project = buildCadProject();
  const options = { velocityMs: 12, angleOfAttackDeg: 0, preset: "quick", seed: 42 };
  const first = runLbmValidation(project, options);
  const second = runLbmValidation(project, options);
  assert.equal(first.measured.dragCoefficient, second.measured.dragCoefficient);
  assert.equal(first.measured.liftCoefficient, second.measured.liftCoefficient);

  const pitched = runLbmValidation(project, { ...options, angleOfAttackDeg: 16 });
  assert.ok(
    pitched.measured.dragCoefficient > first.measured.dragCoefficient,
    `nghiêng 16° phải cản nhiều hơn: ${pitched.measured.dragCoefficient} vs ${first.measured.dragCoefficient}`,
  );
});

test("Lực SI tỷ lệ với bình phương vận tốc ở cùng cấu hình lưới", () => {
  const project = buildCadProject();
  const base = { angleOfAttackDeg: 0, preset: "quick", seed: 9 };
  const slow = runLbmValidation(project, { ...base, velocityMs: 10 });
  const fast = runLbmValidation(project, { ...base, velocityMs: 20 });
  // Cùng Re mô phỏng (omega bị kẹp cả hai) → Cd gần như trùng, lực scale U².
  const ratio = fast.measured.estimatedDragN / slow.measured.estimatedDragN;
  assert.ok(Math.abs(ratio - 4) < 0.4, `tỷ lệ lực ${ratio} phải xấp xỉ 4`);
});

test("Preset lưới cao hơn cho bề dày nhiều ô hơn", () => {
  const project = buildCadProject();
  const quick = runLbmValidation(project, { preset: "quick", seed: 5 });
  const standard = runLbmValidation(project, { preset: "standard", seed: 5 });
  assert.ok(standard.lattice.characteristicCells > quick.lattice.characteristicCells);
  assert.ok(standard.lattice.steps > quick.lattice.steps);
  // Tỷ lệ chắn kênh giữ quanh 10% ở mọi preset.
  assert.ok(standard.report.obstacle.blockageRatio < 0.15);
  assert.ok(quick.report.obstacle.blockageRatio < 0.15);
});

test("Dự án USV chạy ở chế độ thuỷ động với nước biển", () => {
  const project = buildCadProject();
  project.projectId = "usv-survey-01";
  const result = runLbmValidation(project, { velocityMs: 4, preset: "quick", seed: 4 });
  assert.equal(result.mode, "HYDRO-LBM");
  assert.equal(result.domain, "marine");
  assert.equal(result.fluid.densityKgM3, 1025);
  assert.ok(result.fluid.kinematicViscosityM2S < 2e-6);
});

test("Báo cáo Markdown chứa các số liệu then chốt", () => {
  const project = buildCadProject();
  const result = runLbmValidation(project, { preset: "quick", seed: 7 });
  const markdown = lbmReportToMarkdown(result.report, {
    title: "Báo cáo kiểm định",
    cdMean: result.measured.dragCoefficient,
    clRms: result.measured.liftCoefficientRms,
    strouhal: result.measured.strouhal,
  });
  assert.match(markdown, /# Báo cáo kiểm định/);
  assert.match(markdown, /Reynolds mô phỏng/);
  assert.match(markdown, /Momentum Exchange Method/);
  assert.match(markdown, /Tỷ lệ chắn kênh/);
  assert.match(markdown, /C_d = /);
  // Không để lại dòng trống thừa từ các trường tuỳ chọn.
  assert.ok(!markdown.includes("\n\n\n"));
});

test("Catalog shape dựng được vật cản trên lưới", () => {
  assert.ok(LBM_SHAPES.length >= 18);
  for (const shape of LBM_SHAPES) {
    const state = createLbm(120, 80);
    shape.build(state, 40, 40);
    const solidCells = state.solid.reduce((sum, value) => sum + value, 0);
    assert.ok(solidCells > 0, `shape ${shape.id} không tạo được ô solid nào`);
    // Không shape nào được lấp quá 1/4 miền.
    assert.ok(solidCells < state.n / 4, `shape ${shape.id} chiếm ${solidCells} ô`);
  }
});

// ─── Thuật toán mở rộng: MRT · LES · vô hướng thụ động · kích xoáy · đóng khối ───

test("MRT tái hiện đúng vật lý của BGK trên mốc trụ tròn Re=100", () => {
  const latticeVelocity = 0.09;
  const diameter = 20;
  const shared = {
    nx: 320, ny: 210, latticeVelocity,
    omega: omegaForReynolds(latticeVelocity, diameter, 100),
    warmupSteps: 3500, sampleSteps: 1500, sampleEvery: 6,
    random: seededRandom(7),
    build: (state) => presetCylinder(state, 80, 105, diameter / 2),
  };
  const bgk = solveLbm({ ...shared });
  const mrt = solveLbm({ ...shared, collision: "mrt" });
  // Hai mô hình collision phải cho cùng độ nhớt hiệu dụng, nên Cd phải trùng nhau
  // và cùng khớp mốc sách 1.4 — nếu lệch nhiều là ma trận moment sai.
  assert.ok(Math.abs(mrt.cdMean - 1.4) < 0.25, `MRT Cd ${mrt.cdMean}`);
  assert.ok(Math.abs(mrt.cdMean - bgk.cdMean) < 0.12, `MRT ${mrt.cdMean} vs BGK ${bgk.cdMean}`);
});

test("MRT giữ ổn định ở Reynolds mà BGK phân kỳ", () => {
  // Phải gọi stepLbm trực tiếp, KHÔNG qua solveLbm: solveLbm cố tình kẹp omega
  // của BGK ở OMEGA_MAX (1.96) để tránh NaN, nên nó sẽ âm thầm hạ Re và che mất
  // đúng cái mất ổn định mà bài test này cần chứng minh.
  const nx = 260, ny = 120, diameter = 14, u = 0.09;
  const omega = omegaForReynolds(u, diameter, 3000);
  assert.ok(omega > 1.99, `Re=3000 phải đẩy omega sát 2, được ${omega}`);

  const finalState = (collision, smagorinsky) => {
    const state = createLbm(nx, ny);
    initLbm(state, u, 0.01, seededRandom(7));
    presetCylinder(state, 66, 60, diameter / 2);
    for (let i = 0; i < 2500; i += 1) stepLbm(state, omega, u, { collision, smagorinsky });
    let finite = 0, maxSpeed = 0;
    for (let i = 0; i < state.n; i += 1) {
      const speed = Math.hypot(state.ux[i], state.uy[i]);
      if (Number.isFinite(speed)) { finite += 1; if (speed > maxSpeed) maxSpeed = speed; }
    }
    return { finiteRatio: finite / state.n, maxSpeed };
  };

  // Đây chính là lý do MRT tồn tại trong codebase.
  const bgk = finalState("bgk", null);
  assert.ok(bgk.finiteRatio < 0.5, `BGK đáng ra phải phân kỳ ở omega ${omega.toFixed(4)}, còn hữu hạn ${(bgk.finiteRatio * 100).toFixed(0)}%`);

  const mrt = finalState("mrt", 0.14);
  assert.equal(mrt.finiteRatio, 1, "MRT+LES phải giữ toàn bộ trường hữu hạn ở Re=3000");
  assert.ok(mrt.maxSpeed < 0.4, `maxSpeed ${mrt.maxSpeed} — sắp mất ổn định nén được`);
});

test("Smagorinsky LES thoái về laminar khi dòng mượt và tăng nhớt khi dòng bị xé", () => {
  const latticeVelocity = 0.09;
  const diameter = 14;
  const build = (state) => presetCylinder(state, 66, 60, diameter / 2);
  const at = (reynolds, smagorinsky) => solveLbm({
    nx: 260, ny: 120, latticeVelocity,
    omega: omegaForReynolds(latticeVelocity, diameter, reynolds),
    warmupSteps: 2000, sampleSteps: 600, sampleEvery: 6,
    random: seededRandom(5), collision: "mrt", smagorinsky, build,
  });
  // Re thấp: dòng mượt, nhớt xoáy ~0 nên LES gần như không đổi kết quả.
  const laminarOff = at(60, null);
  const laminarOn = at(60, 0.14);
  const laminarShift = Math.abs(laminarOn.cdMean - laminarOff.cdMean) / laminarOff.cdMean;
  assert.ok(laminarShift < 0.05, `LES làm lệch dòng laminar tới ${(laminarShift * 100).toFixed(1)}%`);
  // Re cao: LES phải thực sự tác động (nếu không thì model chỉ là code chết).
  const turbulentOff = at(3000, null);
  const turbulentOn = at(3000, 0.14);
  const fieldShift = turbulentOff.state.ux.reduce((sum, value, index) => sum + Math.abs(value - turbulentOn.state.ux[index]), 0);
  assert.ok(fieldShift > 0, "LES phải làm đổi trường vận tốc ở Re cao");
});

test("Trường vô hướng thụ động đối lưu khói tới hạ lưu và không cuộn vòng qua biên", () => {
  const nx = 200, ny = 100, u = 0.09;
  const state = createLbm(nx, ny);
  initLbm(state, u, 0.01, seededRandom(3));
  presetCylinder(state, 50, 50, 10);
  const field = createScalarField(state);
  const omegaC = scalarOmega(0.008);
  for (let i = 0; i < 1500; i += 1) {
    stepLbm(state, 1.9, u, { collision: "mrt" });
    stepScalar(field, state, omegaC, { stripes: 8, thickness: 3, strength: 1 });
  }
  let downstream = 0;
  for (let y = 1; y < ny - 1; y += 1) for (let x = 150; x < nx - 1; x += 1) downstream += field.c[y * nx + x];
  assert.ok(downstream > 1, `khói phải tới được hạ lưu, tổng ${downstream}`);
  // Nồng độ bị chặn: nếu lattice vô hướng mất ổn định thì giá trị sẽ phân kỳ.
  let maxC = 0;
  for (let i = 0; i < field.n; i += 1) if (field.c[i] > maxC) maxC = field.c[i];
  assert.ok(maxC < 2, `nồng độ cực đại ${maxC} — lattice vô hướng mất ổn định`);
});

test("Hộp kín không cho khói lọt vào khoang — biên vật cản của lattice vô hướng thật sự kín", () => {
  // Bài test này thay cho hai assertion cũ ("Σc trong ô solid == 0" và "c tại x=0
  // == 0") vì cả hai đều KHÔNG THỂ ĐỎ: stepScalar ghi cứng c[i]=0 cho ô solid, và
  // biên inlet zero hoá g tại x=0 — chúng kiểm lại đúng thứ code vừa gán.
  //
  // Thiết kế ở đây: một hộp thành kín có khoang rỗng bên trong, đặt giữa dòng.
  // Khoang chỉ tiếp xúc với dòng ngoài qua thành solid, nên nếu bounce-back của
  // lattice vô hướng hỏng thì khói sẽ rỉ vào khoang và đo được ngay.
  // (Không dùng vách chắn suốt chiều cao kênh: chặn hết dòng làm solver phân kỳ.)
  const nx = 180, ny = 90, u = 0.09;
  const state = createLbm(nx, ny);
  initLbm(state, u, 0.01, seededRandom(4));
  const x0 = 60, x1 = 96, y0 = 30, y1 = 60;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const onWall = y <= y0 + 3 || y >= y1 - 3 || x <= x0 + 3 || x >= x1 - 3;
      if (onWall) state.solid[y * nx + x] = 1;
    }
  }
  const cavity = [];
  for (let y = y0 + 5; y <= y1 - 5; y += 1) for (let x = x0 + 5; x <= x1 - 5; x += 1) cavity.push(y * nx + x);
  assert.ok(cavity.length > 100, "khoang rỗng phải đủ lớn để đo");
  cavity.forEach((i) => assert.equal(state.solid[i], 0, "ô khoang phải là fluid"));

  const field = createScalarField(state);
  const omegaC = scalarOmega(0.02);
  for (let i = 0; i < 2000; i += 1) {
    stepLbm(state, 1.9, u, { collision: "mrt" });
    stepScalar(field, state, omegaC, { stripes: 6, thickness: 4, strength: 1 });
  }
  let outside = 0;
  for (let y = 1; y < ny - 1; y += 1) for (let x = 1; x < x0; x += 1) outside += field.c[y * nx + x];
  const inside = cavity.reduce((sum, i) => sum + field.c[i], 0);
  assert.ok(Number.isFinite(inside) && Number.isFinite(outside), "trường phải hữu hạn");
  assert.ok(outside > 5, `khói phải có mặt ngoài hộp, đo được ${outside}`);
  assert.ok(inside < outside * 0.01, `khói rỉ vào khoang kín: trong ${inside.toFixed(4)} vs ngoài ${outside.toFixed(3)}`);
});

test("Biên trên/dưới của lattice khói chặn được cuộn vòng tuần hoàn", () => {
  // Test ĐƠN VỊ nhắm thẳng vào biên, không dựa vào hành vi nổi lên của dòng.
  //
  // Lý do: bản đầu tôi viết test kiểu "phun khói nửa trên, kiểm nửa dưới sạch" —
  // mutation test cho thấy nó KHÔNG đỏ khi xoá hẳn biên, vì biên free-slip làm
  // uy≈0 sát tường nên khói gần như không bị đẩy dọc qua biên. Test đó đo một thứ
  // không xảy ra. Ở đây nạp thẳng một xung vào hướng +y tại hàng tường DƯỚI: sau
  // một bước streaming, nếu biên không chặn thì bảng tuần hoàn đưa nó lên hàng
  // tường TRÊN và đo được ngay.
  const nx = 40, ny = 20;
  const state = createLbm(nx, ny);
  initLbm(state, 0, 0, seededRandom(1));
  const field = createScalarField(state);
  const probeX = 20;
  // q=2 là hướng +y (xuống dưới màn hình) — xung này sẽ rời miền qua tường dưới.
  field.g[(((ny - 1) * nx) + probeX) * 5 + 2] = 1;
  stepScalar(field, state, 1.0, null);
  const topRow = field.c[0 * nx + probeX];
  assert.equal(topRow, 0, `xung ở tường dưới cuộn vòng lên tường trên: c=${topRow}`);
});

test("Kích xoáy làm bất ổn Karman mọc nhanh hơn nhiều lần", () => {
  const nx = 260, ny = 120, diameter = 14, u = 0.09;
  const omega = omegaForReynolds(u, diameter, 400);
  const growth = (useTrigger) => {
    const state = createLbm(nx, ny);
    initLbm(state, u, 0.01, seededRandom(7));
    presetCylinder(state, 66, 60, diameter / 2);
    const region = sheddingTriggerRegion(state);
    assert.ok(region, "phải suy được vùng kích xoáy từ hộp bao vật cản");
    for (let i = 1; i <= 900; i += 1) {
      stepLbm(state, omega, u, { collision: "mrt", smagorinsky: 0.14 });
      if (useTrigger && i < 300) applyTransverseImpulse(state, region, 0.004);
    }
    const denom = 0.5 * u * u * diameter;
    const cl = [];
    for (let k = 0; k < 400; k += 1) {
      stepLbm(state, omega, u, { collision: "mrt", smagorinsky: 0.14 });
      if (k % 4 === 0) cl.push(momentumExchangeForces(state).fy / denom);
    }
    const mean = cl.reduce((a, b) => a + b, 0) / cl.length;
    return Math.sqrt(cl.reduce((a, b) => a + (b - mean) ** 2, 0) / cl.length);
  };
  const without = growth(false);
  const withTrigger = growth(true);
  assert.ok(withTrigger > without * 3, `kích xoáy phải khuếch đại dao động: ${withTrigger} vs ${without}`);
});

test("Đóng hình thái học hàn bóng dự án thành một khối liền", () => {
  const project = buildCadProject();
  const components = (closeRadius) => {
    const state = createLbm(260, 120);
    rasterizeScene(state, project.scene, { plane: "side", crossStreamCells: 14, closeRadius });
    const seen = new Uint8Array(state.n);
    let count = 0;
    for (let start = 0; start < state.n; start += 1) {
      if (!state.solid[start] || seen[start]) continue;
      count += 1;
      const stack = [start];
      seen[start] = 1;
      while (stack.length > 0) {
        const cell = stack.pop();
        const x = cell % 260;
        const y = (cell - x) / 260;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || nx2 >= 260 || ny2 < 0 || ny2 >= 120) continue;
          const next = ny2 * 260 + nx2;
          if (state.solid[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
        }
      }
    }
    return count;
  };
  // Bóng chiếu thô vỡ thành nhiều mảnh rời — dòng lách qua kẽ hở nên vừa sai vật
  // lý vừa trông như chảy quanh mảnh vụn.
  assert.ok(components(0) > 1, "bóng thô đáng ra phải rời rạc");
  assert.equal(components(3), 1, "đóng bán kính 3 phải cho một khối liền");
});
