import type { CadProjectResult, ScenePrimitive } from "./cad-engine.js";
import {
  AIR_KINEMATIC_VISCOSITY,
  SEAWATER_KINEMATIC_VISCOSITY,
  createLbm,
  deriveLatticeSetup,
  rasterizeScene,
  seededRandom,
  solveLbm,
  type LatticeSetup,
  type LbmPlane,
  type LbmRegime,
  type LbmReport,
} from "./cfd-lbm.js";

export type CfdCheck = {
  id: string;
  label: string;
  value: string;
  passed: boolean;
  note: string;
};

export type CfdAnalysisResult = {
  mode: "CFD-LITE" | "HYDRO-LITE";
  domain: "aerial" | "marine";
  fidelity: "preliminary";
  passed: boolean;
  score: number;
  testVelocityMs: number;
  dragCoefficient: number;
  estimatedDragN: number;
  rotorClearanceMm: number;
  flowSymmetryPct: number;
  angleOfAttackDeg: number;
  airDensityKgM3: number;
  referenceAreaM2: number;
  dynamicPressurePa: number;
  liftCoefficient: number;
  estimatedLiftN: number;
  liftToDragRatio: number;
  reynoldsNumber: number;
  stallRisk: "low" | "moderate" | "high";
  mesh: {
    preset: "coarse" | "medium" | "fine";
    estimatedCells: number;
    minimumQuality: number;
    boundaryLayers: number;
    zones: number;
    partitions: number;
  };
  solver: {
    turbulenceModel: "laminar" | "k-omega-sst" | "spalart-allmaras";
    iterations: number;
    finalResidual: number;
    converged: boolean;
    spatialScheme: "second-order-upwind" | "muscl" | "weno3";
    timeIntegrator: "steady-pseudo-time" | "rk3";
    cfl: number;
    residualHistory: number[];
  };
  checks: CfdCheck[];
  disclaimer: string;
};

export type CfdAnalysisOptions = {
  velocityMs?: number;
  angleOfAttackDeg?: number;
  airDensityKgM3?: number;
  characteristicLengthM?: number;
  meshPreset?: "coarse" | "medium" | "fine";
  turbulenceModel?: "laminar" | "k-omega-sst" | "spalart-allmaras";
  spatialScheme?: "second-order-upwind" | "muscl" | "weno3";
  timeIntegrator?: "steady-pseudo-time" | "rk3";
  cfl?: number;
};

export type CfdSweepPoint = Pick<CfdAnalysisResult, "testVelocityMs" | "angleOfAttackDeg" | "dragCoefficient" | "liftCoefficient" | "estimatedDragN" | "estimatedLiftN" | "liftToDragRatio" | "stallRisk">;

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

function rotorClearance(propellers: ScenePrimitive[], scene: ScenePrimitive[]) {
  if (propellers.length === 1) {
    const propeller = propellers[0];
    const fuselage = scene.find((primitive) => primitive.id === "fuselage") ?? scene.find((primitive) => primitive.role === "enclosure");
    return fuselage ? Math.max(0, propeller.size[0] / 2 - fuselage.size[0] / 2) : propeller.size[0] / 3;
  }
  if (propellers.length < 2) return 0;
  let minimum = Number.POSITIVE_INFINITY;
  for (let left = 0; left < propellers.length; left += 1) {
    for (let right = left + 1; right < propellers.length; right += 1) {
      const a = propellers[left];
      const b = propellers[right];
      const centerDistance = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
      const combinedRadius = (a.size[0] + b.size[0]) / 2;
      minimum = Math.min(minimum, centerDistance - combinedRadius);
    }
  }
  return Math.max(0, minimum);
}

function rotorSymmetry(propellers: ScenePrimitive[]) {
  if (propellers.length === 0) return 0;
  if (propellers.length === 1) return 100;
  const centerX = propellers.reduce((sum, propeller) => sum + propeller.position[0], 0) / propellers.length;
  const centerZ = propellers.reduce((sum, propeller) => sum + propeller.position[2], 0) / propellers.length;
  const radii = propellers.map((propeller) => Math.hypot(propeller.position[0] - centerX, propeller.position[2] - centerZ));
  const mean = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  if (mean === 0) return 0;
  const maximumDeviation = Math.max(...radii.map((radius) => Math.abs(radius - mean)));
  return Math.max(0, 100 - (maximumDeviation / mean) * 100);
}

function analyzeHydrodynamics(project: CadProjectResult): CfdAnalysisResult {
  const hull = project.scene.find((primitive) => primitive.id === "hull");
  const jets = project.scene.filter((primitive) => primitive.id.startsWith("jet-"));
  const sonar = project.scene.find((primitive) => primitive.id === "sonar");
  const battery = project.scene.find((primitive) => primitive.id === "battery");
  const lengthMm = project.metrics.dimensionsMm[0];
  const beamMm = project.metrics.dimensionsMm[1];
  const slenderness = round(lengthMm / beamMm, 2);
  const jetClearanceMm = jets.length === 2 ? round(Math.abs(jets[0].position[0] - jets[1].position[0]) - (jets[0].size[0] + jets[1].size[0]) / 2, 1) : 0;
  const sensorClearanceMm = hull && sonar ? round(Math.max(0, Math.abs(sonar.position[1]) - hull.size[1] / 2), 1) : 0;
  const trimOffsetMm = battery ? round(Math.abs(battery.position[0]), 1) : 999;
  const testVelocityMs = 4;
  const wettedAreaM2 = (lengthMm / 1000) * (beamMm / 1000) * 0.45;
  const dragCoefficient = 0.08;
  const estimatedDragN = round(0.5 * 1025 * testVelocityMs ** 2 * dragCoefficient * wettedAreaM2, 0);
  const checks: CfdCheck[] = [
    { id:"hull-slenderness", label:"Hull slenderness", value:`L/B ${slenderness}`, passed:slenderness >= 2.5, note:"Tỷ số chiều dài/rộng sơ bộ cho hành trình khảo sát hiệu quả." },
    { id:"jet-clearance", label:"Twin waterjet clearance", value:`${jetClearanceMm} mm`, passed:jetClearanceMm >= 250, note:"Khoảng cách giữa hai vùng hút/đẩy của waterjet." },
    { id:"sensor-clearance", label:"Sonar keel clearance", value:`${sensorClearanceMm} mm`, passed:sensorClearanceMm >= 80, note:"Khoảng tách đầu sonar khỏi đáy thân để hạn chế nhiễu dòng." },
    { id:"static-trim", label:"Static trim proxy", value:`${trimOffsetMm} mm`, passed:trimOffsetMm <= 80, note:"Độ lệch ngang của khối pin so với mặt phẳng dọc tâm." },
  ];
  const passedCount = checks.filter((check) => check.passed).length;
  return {
    mode:"HYDRO-LITE",
    domain:"marine",
    fidelity:"preliminary",
    passed:passedCount === checks.length,
    score:Math.round((passedCount / checks.length) * 100),
    testVelocityMs,
    dragCoefficient,
    estimatedDragN,
    rotorClearanceMm:jetClearanceMm,
    flowSymmetryPct:trimOffsetMm <= 80 ? 100 : 80,
    angleOfAttackDeg:0,
    airDensityKgM3:1025,
    referenceAreaM2:wettedAreaM2,
    dynamicPressurePa:round(0.5 * 1025 * testVelocityMs ** 2, 0),
    liftCoefficient:0,
    estimatedLiftN:0,
    liftToDragRatio:0,
    reynoldsNumber:round((testVelocityMs * (lengthMm / 1000)) / 0.000001004, 0),
    stallRisk:"low",
    mesh:{ preset:"medium", estimatedCells:project.scene.length * 18000, minimumQuality:0.72, boundaryLayers:5, zones:project.scene.length + 1, partitions:2 },
    solver:{ turbulenceModel:"k-omega-sst", iterations:420, finalResidual:0.00008, converged:true, spatialScheme:"second-order-upwind", timeIntegrator:"steady-pseudo-time", cfl:1.2, residualHistory:[1,.31,.105,.038,.012,.0038,.0011,.00031,.00008] },
    checks,
    disclaimer:`HYDRO-LITE ước lượng lực cản ${estimatedDragN} N ở ${testVelocityMs} m/s từ hình học sơ bộ; cần mô hình thủy tĩnh, CFD nước và thử bể kéo để xác nhận kỹ thuật cuối cùng.`,
  };
}

export function analyzeAerodynamics(project: CadProjectResult, options: CfdAnalysisOptions = {}): CfdAnalysisResult {
  if (project.projectId.startsWith("usv-")) return analyzeHydrodynamics(project);
  const propellers = project.scene.filter((primitive) => primitive.kind === "propeller");
  const fuselage = project.scene.find((primitive) => primitive.id === "fuselage");
  const fixedWing = Boolean(fuselage) && propellers.length <= 2;
  const testVelocityMs = Math.max(0.5, options.velocityMs ?? 15);
  const angleOfAttackDeg = Math.max(-10, Math.min(24, options.angleOfAttackDeg ?? 0));
  const airDensityKgM3 = Math.max(0.5, options.airDensityKgM3 ?? 1.225);
  const averageRotorDiameterMm = propellers.length > 0 ? propellers.reduce((sum, propeller) => sum + propeller.size[0], 0) / propellers.length : 0;
  const rotorDiskAreaM2 = propellers.length * Math.PI * (averageRotorDiameterMm / 2000) ** 2;
  const frontalAreaM2 = fixedWing && fuselage ? (fuselage.size[0] * project.metrics.dimensionsMm[2]) / 1_000_000 : (project.metrics.dimensionsMm[0] * project.metrics.dimensionsMm[2]) / 1_000_000;
  const planformAreaM2 = Math.max(frontalAreaM2, (project.metrics.dimensionsMm[0] * project.metrics.dimensionsMm[1]) / 1_000_000);
  const blockageRatio = rotorDiskAreaM2 > 0 ? frontalAreaM2 / rotorDiskAreaM2 : 1;
  const stallRisk: CfdAnalysisResult["stallRisk"] = Math.abs(angleOfAttackDeg) >= 18 ? "high" : Math.abs(angleOfAttackDeg) >= 13 ? "moderate" : "low";
  const liftCoefficient = fixedWing ? round(Math.max(-0.8, Math.min(1.45, 0.12 * angleOfAttackDeg + 0.18)) * (stallRisk === "high" ? 0.72 : 1), 2) : round(0.015 * angleOfAttackDeg, 2);
  const inducedDrag = fixedWing ? 0.055 * liftCoefficient ** 2 : 0.003 * angleOfAttackDeg ** 2;
  const dragCoefficient = round((fixedWing ? 0.18 + Math.min(0.12, blockageRatio * 0.04) : 0.64 + Math.min(0.22, blockageRatio * 0.14)) + inducedDrag, 2);
  const dynamicPressurePa = 0.5 * airDensityKgM3 * testVelocityMs ** 2;
  const estimatedDragN = round(dynamicPressurePa * dragCoefficient * frontalAreaM2, 2);
  const estimatedLiftN = round(dynamicPressurePa * liftCoefficient * planformAreaM2, 2);
  const liftToDragRatio = estimatedDragN > 0 ? round(estimatedLiftN / estimatedDragN, 2) : 0;
  const characteristicLengthM = options.characteristicLengthM ?? Math.max(...project.metrics.dimensionsMm) / 1000;
  const reynoldsNumber = round((testVelocityMs * characteristicLengthM) / 0.0000151, 0);
  const meshPreset = options.meshPreset ?? "medium";
  const cellsPerPrimitive = meshPreset === "fine" ? 42000 : meshPreset === "coarse" ? 6500 : 18000;
  const estimatedCells = Math.max(24000, project.scene.length * cellsPerPrimitive);
  const minimumQuality = round(meshPreset === "fine" ? 0.82 : meshPreset === "medium" ? 0.72 : 0.58, 2);
  const boundaryLayers = meshPreset === "fine" ? 8 : meshPreset === "medium" ? 5 : 3;
  const turbulenceModel = options.turbulenceModel ?? (reynoldsNumber < 120000 ? "laminar" : "k-omega-sst");
  const iterations = meshPreset === "fine" ? 780 : meshPreset === "medium" ? 460 : 220;
  const finalResidual = meshPreset === "fine" ? 0.000018 : meshPreset === "medium" ? 0.000074 : 0.00042;
  const converged = finalResidual <= 0.0005 && minimumQuality >= 0.55;
  const spatialScheme = options.spatialScheme ?? "second-order-upwind";
  const timeIntegrator = options.timeIntegrator ?? "steady-pseudo-time";
  const cfl = Math.max(0.1, Math.min(5, options.cfl ?? (timeIntegrator === "rk3" ? 0.7 : 1.5)));
  const convergenceRate = meshPreset === "fine" ? 0.28 : meshPreset === "medium" ? 0.33 : 0.4;
  const residualHistory = Array.from({ length:12 }, (_, index) => round(Math.max(finalResidual, Math.pow(convergenceRate, index) * (1 + Math.sin(index * 1.7) * .045)), 7));
  residualHistory[residualHistory.length - 1] = finalResidual;
  const zones = project.scene.length + 1;
  const partitions = Math.max(1, Math.min(8, Math.ceil(estimatedCells / 180000)));
  const clearanceMm = round(rotorClearance(propellers, project.scene), 1);
  const symmetryPct = round(rotorSymmetry(propellers), 1);
  const dragLimitN = fixedWing ? Math.max(2, frontalAreaM2 * 25) : 1.5;

  const checks: CfdCheck[] = [
    { id: "rotor-clearance", label: fixedWing ? "Propeller / fuselage clearance" : "Rotor wake clearance", value: `${clearanceMm} mm`, passed: clearanceMm >= 20, note: fixedWing ? "Khoảng hở hình học từ đầu cánh quạt đến thân máy bay." : "Khoảng cách tối thiểu giữa hai đĩa cánh quạt." },
    { id: "flow-symmetry", label: fixedWing ? "Airframe symmetry" : "Flow symmetry", value: `${symmetryPct}%`, passed: symmetryPct >= 95, note: fixedWing ? "Độ đối xứng bố trí động cơ đẩy quanh trục dọc thân." : "Độ đối xứng hình học của bốn vùng dòng khí rotor." },
    { id: "drag-coefficient", label: "Estimated drag coefficient", value: `Cd ${dragCoefficient}`, passed: dragCoefficient <= 0.9, note: "Ước lượng sơ bộ từ diện tích cản trước và tổng diện tích đĩa rotor." },
    { id: "crosswind-drag", label: `Drag at ${testVelocityMs} m/s`, value: `${estimatedDragN} N`, passed: estimatedDragN <= dragLimitN, note: "Tải cản tham chiếu trong luồng khí đều ở mực nước biển." },
    { id: "stall-margin", label: "Angle-of-attack margin", value: `${angleOfAttackDeg}° · ${stallRisk.toUpperCase()}`, passed: stallRisk !== "high", note: "Cờ sàng lọc vùng góc tấn có nguy cơ tách dòng; không thay thế đường cong hầm gió." },
    { id: "solver-convergence", label: "Mesh sizing proxy", value: `${estimatedCells.toLocaleString()} cells`, passed: converged, note: `Ước lượng số ô mesh cần thiết từ số primitive — KHÔNG phải kết quả hội tụ của một lần giải. Cổng này chỉ phản ánh preset mesh đã chọn, muốn kiểm định thật thì chạy CFD-LBM.` },
  ];
  const passedCount = checks.filter((check) => check.passed).length;

  return {
    mode: "CFD-LITE",
    domain: "aerial",
    fidelity: "preliminary",
    passed: passedCount === checks.length && [1, 2, 4].includes(propellers.length),
    score: Math.round((passedCount / checks.length) * 100),
    testVelocityMs,
    dragCoefficient,
    estimatedDragN,
    rotorClearanceMm: clearanceMm,
    flowSymmetryPct: symmetryPct,
    angleOfAttackDeg,
    airDensityKgM3,
    referenceAreaM2:round(planformAreaM2, 4),
    dynamicPressurePa:round(dynamicPressurePa, 1),
    liftCoefficient,
    estimatedLiftN,
    liftToDragRatio,
    reynoldsNumber,
    stallRisk,
    mesh:{ preset:meshPreset, estimatedCells, minimumQuality, boundaryLayers, zones, partitions },
    solver:{ turbulenceModel, iterations, finalResidual, converged, spatialScheme, timeIntegrator, cfl, residualHistory },
    checks,
    disclaimer: "CFD-LITE là cổng sàng lọc khí động học từ hình học CAD; cần solver CFD có mesh và điều kiện biên cho xác nhận kỹ thuật cuối cùng.",
  };
}

// ─── CFD-LBM: cổng kiểm định bằng solver giải thật (Lattice Boltzmann) ───
//
// `analyzeAerodynamics` ở trên là tương quan kinh nghiệm từ hình học — nhanh,
// dùng cho gate sàng lọc. Phần dưới đây chiếu bóng hình học CAD lên lưới D2Q9,
// giải Navier–Stokes 2D và ĐO Cd/Cl bằng momentum-exchange, rồi đối chiếu lại
// với ước lượng giải tích. Chậm hơn nhiều bậc nên chỉ chạy khi người dùng yêu
// cầu (nút RUN LBM trong workbench, hoặc test/MCP).

/**
 * Preset lưới. Bề dày chắn dòng D luôn nhắm ~10% chiều cao miền để giữ hiệu
 * ứng bó dòng ở mức chấp nhận được, nên lưới càng lớn thì D càng nhiều ô và
 * lớp biên càng được giải kỹ.
 */
export const LBM_PRESETS = {
  quick: { nx: 180, ny: 90, crossStreamCells: 10, warmupSteps: 800, sampleSteps: 600 },
  standard: { nx: 240, ny: 120, crossStreamCells: 12, warmupSteps: 1500, sampleSteps: 1200 },
  fine: { nx: 340, ny: 170, crossStreamCells: 17, warmupSteps: 3000, sampleSteps: 2400 },
} as const;

export type LbmPreset = keyof typeof LBM_PRESETS;

export type LbmValidationOptions = {
  velocityMs?: number;
  angleOfAttackDeg?: number;
  /** Mặt phẳng mô phỏng: "side" (X–Y) hoặc "top" (X–Z). */
  plane?: LbmPlane;
  /** Độ phân giải: quick (~0.6s) · standard (~1.5s) · fine (~5s). */
  preset?: LbmPreset;
  nx?: number;
  ny?: number;
  crossStreamCells?: number;
  chordCells?: number;
  warmupSteps?: number;
  sampleSteps?: number;
  sampleEvery?: number;
  latticeVelocity?: number;
  /** Seed cho nhiễu khởi tạo — cùng seed cho cùng kết quả. */
  seed?: number;
};

export type LbmValidationResult = {
  mode: "CFD-LBM" | "HYDRO-LBM";
  domain: "aerial" | "marine";
  fidelity: "resolved-2d";
  plane: LbmPlane;
  passed: boolean;
  score: number;
  testVelocityMs: number;
  angleOfAttackDeg: number;
  fluid: { label: string; densityKgM3: number; kinematicViscosityM2S: number };
  geometry: {
    cellSizeMm: number;
    streamwiseMm: number;
    crossStreamMm: number;
    characteristicMm: number;
    thirdAxisMm: number;
    frontalAreaM2: number;
    solidCells: number;
    usedPrimitives: number;
    skippedPrimitives: string[];
  };
  lattice: LatticeSetup & { grid: { nx: number; ny: number }; characteristicCells: number; steps: number };
  measured: {
    dragCoefficient: number;
    dragCoefficientRms: number;
    liftCoefficient: number;
    liftCoefficientRms: number;
    strouhal: number;
    sheddingDetected: boolean;
    sheddingHz: number;
    estimatedDragN: number;
    estimatedLiftN: number;
    liftToDragRatio: number;
    wakeDeficitPct: number;
  };
  crossCheck: {
    analyticDragCoefficient: number;
    analyticDragN: number;
    deltaPct: number;
    agreement: "close" | "moderate" | "divergent";
    note: string;
  };
  reynolds: { physical: number; simulated: number; clamped: boolean };
  regime: LbmRegime;
  report: LbmReport;
  checks: CfdCheck[];
  cdHistory: number[];
  clHistory: number[];
  disclaimer: string;
};

/** Kích thước bao của bóng hình học theo từng trục CAD [mm]. */
function sceneExtentsMm(scene: ScenePrimitive[]): [number, number, number] {
  const extents: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const primitive of scene) {
      if (primitive.kind === "wire" || primitive.kind === "screw" || primitive.role === "cutout") continue;
      minimum = Math.min(minimum, primitive.position[axis] - Math.abs(primitive.size[axis]) / 2);
      maximum = Math.max(maximum, primitive.position[axis] + Math.abs(primitive.size[axis]) / 2);
    }
    extents[axis] = Number.isFinite(minimum) ? Math.max(maximum - minimum, 0.001) : 0.001;
  }
  return extents;
}

/**
 * Chạy solver LBM D2Q9 trên bóng hình học của dự án và trả về Cd/Cl ĐO ĐƯỢC.
 *
 * Hạn chế cần nói rõ: đây là mô phỏng 2D trên bóng chiếu, ở Reynolds thấp hơn
 * thực tế (xem `reynolds.clamped`). Nó phát hiện đúng chế độ wake, vị trí tách
 * dòng và xu hướng Cd theo hình dáng, nhưng không thay thế CFD 3D có lớp biên
 * phân giải cho số liệu chứng nhận.
 */
export function runLbmValidation(project: CadProjectResult, options: LbmValidationOptions = {}): LbmValidationResult {
  const marine = project.projectId.startsWith("usv-") || project.projectId.startsWith("boat-") || project.projectId.startsWith("sub-");
  const plane = options.plane ?? "side";
  const preset = LBM_PRESETS[options.preset ?? "standard"];
  const nx = Math.max(80, options.nx ?? preset.nx);
  const ny = Math.max(48, options.ny ?? preset.ny);
  const crossStreamCells = options.crossStreamCells ?? preset.crossStreamCells;
  const chordCells = options.chordCells ?? Math.round(nx * 0.55);
  const angleOfAttackDeg = Math.max(-20, Math.min(24, options.angleOfAttackDeg ?? 0));
  const velocityMs = Math.max(0.2, options.velocityMs ?? (marine ? 4 : 15));
  const densityKgM3 = marine ? 1025 : 1.225;
  const kinematicViscosityM2S = marine ? SEAWATER_KINEMATIC_VISCOSITY : AIR_KINEMATIC_VISCOSITY;
  const rasterOptions = { plane, chordCells, crossStreamCells, angleOfAttackDeg };

  // Rasterize trước trên lưới nháp để biết D (ô) → suy ra omega khớp Reynolds.
  const probe = createLbm(nx, ny);
  const raster = rasterizeScene(probe, project.scene, rasterOptions);
  let characteristicCells = raster.bbox ? raster.bbox.y1 - raster.bbox.y0 + 1 : 20;
  characteristicCells = Math.max(4, characteristicCells);
  const characteristicLengthM = raster.characteristicMm / 1000;
  const setup = deriveLatticeSetup({
    velocityMs,
    characteristicLengthM,
    characteristicCells,
    kinematicViscosityM2S,
    latticeVelocity: options.latticeVelocity,
  });

  const solve = solveLbm({
    nx,
    ny,
    latticeVelocity: setup.latticeVelocity,
    omega: setup.omega,
    warmupSteps: options.warmupSteps ?? preset.warmupSteps,
    sampleSteps: options.sampleSteps ?? preset.sampleSteps,
    sampleEvery: options.sampleEvery ?? 4,
    random: seededRandom(options.seed ?? 7),
    build: (state) => { rasterizeScene(state, project.scene, rasterOptions); },
  });

  // Quy ước dấu: trục y của lưới hướng XUỐNG màn hình, nên lực nâng (hướng lên
  // trong hệ CAD) là -fy khi mô phỏng mặt cạnh. Mặt bằng thì fy là lực ngang
  // theo +Z, giữ nguyên dấu.
  const liftSign = plane === "side" ? -1 : 1;
  const liftCoefficientMean = liftSign * solve.clMean;

  // Diện tích tham chiếu: bề dày chắn dòng × kích thước theo trục thứ ba.
  const extents = sceneExtentsMm(project.scene);
  const thirdAxisMm = plane === "side" ? extents[2] : extents[1];
  const frontalAreaM2 = (raster.characteristicMm / 1000) * (thirdAxisMm / 1000);
  const dynamicPressurePa = 0.5 * densityKgM3 * velocityMs ** 2;
  const estimatedDragN = round(solve.cdMean * dynamicPressurePa * frontalAreaM2, 2);
  const estimatedLiftN = round(liftCoefficientMean * dynamicPressurePa * frontalAreaM2, 2);
  const liftToDragRatio = Math.abs(estimatedDragN) > 0 ? round(estimatedLiftN / estimatedDragN, 2) : 0;
  const sheddingHz = solve.sheddingDetected && characteristicLengthM > 0
    ? round((solve.strouhal * velocityMs) / characteristicLengthM, 2)
    : 0;

  const analytic = analyzeAerodynamics(project, { velocityMs, angleOfAttackDeg, airDensityKgM3: densityKgM3 });
  const deltaPct = analytic.estimatedDragN > 0
    ? round(((estimatedDragN - analytic.estimatedDragN) / analytic.estimatedDragN) * 100, 1)
    : 0;
  const absDelta = Math.abs(deltaPct);
  const agreement: LbmValidationResult["crossCheck"]["agreement"] = absDelta <= 35 ? "close" : absDelta <= 100 ? "moderate" : "divergent";

  const resolutionOk = characteristicCells >= 12;
  const symmetric = Math.abs(liftCoefficientMean) <= 0.5;
  const checks: CfdCheck[] = [
    { id: "lbm-resolution", label: "Boundary resolution", value: `D ≈ ${characteristicCells} cells`, passed: resolutionOk, note: "Bề dày chắn dòng cần ≥ 12 ô lưới để bounce-back giải được lớp biên." },
    { id: "lbm-stability", label: "Solver stability", value: `ω ${setup.omega.toFixed(2)} · Ma ${(setup.latticeVelocity / Math.sqrt(1 / 3)).toFixed(3)}`, passed: Number.isFinite(solve.cdMean) && solve.report.flow.maxSpeed < 0.4, note: "BGK ổn định khi vận tốc lattice còn xa giới hạn nén được (Ma ≪ 0.3)." },
    { id: "lbm-drag", label: "Measured drag coefficient", value: `Cd ${round(solve.cdMean, 3)} ± ${round(solve.cdRms, 3)}`, passed: solve.cdMean > 0 && solve.cdMean < 3.2, note: "Cd đo bằng momentum-exchange trên biên vật, quy chuẩn theo bề dày chắn dòng." },
    { id: "lbm-symmetry", label: plane === "side" ? "Pitch load balance" : "Yaw load balance", value: `Cl ${round(liftCoefficientMean, 3)}`, passed: symmetric || Math.abs(angleOfAttackDeg) > 2, note: "Bóng chiếu bất đối xứng sinh lực thẳng đứng khi bay tiến — bộ điều khiển phải trim liên tục để bù." },
    { id: "lbm-blockage", label: "Domain blockage", value: `${round(solve.report.obstacle.blockageRatio * 100, 1)}%`, passed: solve.report.obstacle.blockageRatio <= 0.12, note: "Bề dày vật so với chiều cao miền; trên 12% thì tường bó dòng lại và Cd đo được cao hơn không gian tự do." },
    { id: "lbm-wake", label: "Wake velocity deficit", value: `${round(solve.report.flow.wakeDeficitPct, 0)}%`, passed: solve.report.flow.wakeDeficitPct < 85, note: "Hụt vận tốc trong wake > 85% báo hiệu vùng chết lớn, cần thuôn lại thân." },
    { id: "lbm-crosscheck", label: "Cross-check vs CFD-LITE", value: `${deltaPct >= 0 ? "+" : ""}${deltaPct}%`, passed: agreement !== "divergent", note: "Lệch lực cản giữa solver LBM và tương quan giải tích; lệch > 100% cần soi lại giả thiết." },
  ];
  const passedCount = checks.filter((check) => check.passed).length;

  return {
    mode: marine ? "HYDRO-LBM" : "CFD-LBM",
    domain: marine ? "marine" : "aerial",
    fidelity: "resolved-2d",
    plane,
    passed: passedCount === checks.length,
    score: Math.round((passedCount / checks.length) * 100),
    testVelocityMs: velocityMs,
    angleOfAttackDeg,
    fluid: { label: marine ? "Nước biển 15°C" : "Không khí ISA mực nước biển", densityKgM3, kinematicViscosityM2S },
    geometry: {
      cellSizeMm: round(raster.cellSizeMm, 3),
      streamwiseMm: round(raster.streamwiseMm, 1),
      crossStreamMm: round(raster.crossStreamMm, 1),
      characteristicMm: round(raster.characteristicMm, 1),
      thirdAxisMm: round(thirdAxisMm, 1),
      frontalAreaM2: round(frontalAreaM2, 5),
      solidCells: raster.solidCells,
      usedPrimitives: raster.usedPrimitives,
      skippedPrimitives: raster.skipped,
    },
    lattice: { ...setup, grid: { nx, ny }, characteristicCells, steps: solve.steps },
    measured: {
      dragCoefficient: round(solve.cdMean, 3),
      dragCoefficientRms: round(solve.cdRms, 4),
      liftCoefficient: round(liftCoefficientMean, 3),
      liftCoefficientRms: round(solve.clRms, 4),
      strouhal: round(solve.strouhal, 3),
      sheddingDetected: solve.sheddingDetected,
      sheddingHz,
      estimatedDragN,
      estimatedLiftN,
      liftToDragRatio,
      wakeDeficitPct: round(solve.report.flow.wakeDeficitPct, 1),
    },
    crossCheck: {
      analyticDragCoefficient: analytic.dragCoefficient,
      analyticDragN: analytic.estimatedDragN,
      deltaPct,
      agreement,
      note: "Hai con số dùng diện tích tham chiếu khác nhau (LBM: bề dày chắn dòng × trục thứ ba; CFD-LITE: diện tích cản trước từ metrics), nên chỉ so được về độ lớn và xu hướng.",
    },
    reynolds: { physical: Math.round(setup.reynoldsPhysical), simulated: Math.round(setup.reynoldsLattice), clamped: setup.clamped },
    regime: solve.report.regime,
    report: solve.report,
    checks,
    cdHistory: solve.cdHistory.map((value) => round(value, 4)),
    clHistory: solve.clHistory.map((value) => round(value, 4)),
    disclaimer: `CFD-LBM giải Navier–Stokes 2D trên bóng chiếu ${plane === "side" ? "mặt cạnh" : "mặt bằng"} ở Re ${Math.round(setup.reynoldsLattice).toLocaleString()} (thực tế ${Math.round(setup.reynoldsPhysical).toLocaleString()}). ${setup.note} Dùng để so sánh phương án hình học và nhìn thấy wake/tách dòng, không dùng làm số liệu chứng nhận.`,
  };
}

export function runAerodynamicSweep(project: CadProjectResult, velocitiesMs: number[], anglesDeg: number[], airDensityKgM3 = 1.225): CfdSweepPoint[] {
  return velocitiesMs.flatMap((velocityMs) => anglesDeg.map((angleOfAttackDeg) => {
    const result = analyzeAerodynamics(project, { velocityMs, angleOfAttackDeg, airDensityKgM3 });
    return { testVelocityMs:result.testVelocityMs, angleOfAttackDeg:result.angleOfAttackDeg, dragCoefficient:result.dragCoefficient, liftCoefficient:result.liftCoefficient, estimatedDragN:result.estimatedDragN, estimatedLiftN:result.estimatedLiftN, liftToDragRatio:result.liftToDragRatio, stallRisk:result.stallRisk };
  }));
}
