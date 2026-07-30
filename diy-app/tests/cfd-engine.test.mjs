import assert from "node:assert/strict";
import test from "node:test";
import { buildCadProject } from "../dist-mcp/lib/cad-engine.js";
import { analyzeAerodynamics, runAerodynamicSweep } from "../dist-mcp/lib/cfd-engine.js";

test("CFD preflight passes the symmetric Budget Mini UAV geometry", () => {
  const result = analyzeAerodynamics(buildCadProject());
  assert.equal(result.mode, "CFD-LITE");
  assert.equal(result.passed, true);
  assert.equal(result.flowSymmetryPct, 100);
  assert.ok(result.rotorClearanceMm >= 20);
  assert.equal(result.checks.length, 6);
});

test("CFD preflight detects asymmetric rotor placement", () => {
  const project = buildCadProject();
  const propeller = project.scene.find((primitive) => primitive.id === "propeller-fl");
  assert.ok(propeller);
  propeller.position = [-25, propeller.position[1], -25];
  const result = analyzeAerodynamics(project);
  assert.equal(result.passed, false);
  assert.ok(result.flowSymmetryPct < 95 || result.rotorClearanceMm < 20);
});

test("CFD force scales with the square of flow velocity", () => {
  const project = buildCadProject();
  const slow = analyzeAerodynamics(project, { velocityMs: 10, angleOfAttackDeg: 4 });
  const fast = analyzeAerodynamics(project, { velocityMs: 20, angleOfAttackDeg: 4 });
  assert.ok(Math.abs(fast.estimatedDragN / slow.estimatedDragN - 4) < 0.08);
  assert.ok(Math.abs(fast.dynamicPressurePa / slow.dynamicPressurePa - 4) < 0.01);
});

test("CFD flags high angle of attack and produces a deterministic sweep", () => {
  const project = buildCadProject();
  const stalled = analyzeAerodynamics(project, { velocityMs: 16, angleOfAttackDeg: 20 });
  assert.equal(stalled.stallRisk, "high");
  assert.equal(stalled.checks.find((check) => check.id === "stall-margin")?.passed, false);
  const sweep = runAerodynamicSweep(project, [10, 20], [0, 8]);
  assert.equal(sweep.length, 4);
  assert.deepEqual(sweep.map((point) => [point.testVelocityMs, point.angleOfAttackDeg]), [[10, 0], [10, 8], [20, 0], [20, 8]]);
});

test("fine mesh increases cell count and retains converged solver metadata", () => {
  const project = buildCadProject();
  const coarse = analyzeAerodynamics(project, { meshPreset: "coarse" });
  const fine = analyzeAerodynamics(project, { meshPreset: "fine", turbulenceModel: "spalart-allmaras" });
  assert.ok(fine.mesh.estimatedCells > coarse.mesh.estimatedCells);
  assert.ok(fine.mesh.minimumQuality > coarse.mesh.minimumQuality);
  assert.equal(fine.solver.turbulenceModel, "spalart-allmaras");
  assert.equal(fine.solver.converged, true);
});

test("OneFLOW-inspired numerics metadata preserves scheme, CFL and partitions", () => {
  const result = analyzeAerodynamics(buildCadProject(), { meshPreset: "fine", spatialScheme: "weno3", timeIntegrator: "rk3", cfl: .7 });
  assert.equal(result.solver.spatialScheme, "weno3");
  assert.equal(result.solver.timeIntegrator, "rk3");
  assert.equal(result.solver.cfl, .7);
  assert.equal(result.solver.residualHistory.length, 12);
  assert.ok(result.solver.residualHistory.at(-1) < result.solver.residualHistory[0]);
  assert.ok(result.mesh.zones > 1);
  assert.ok(result.mesh.partitions >= 1);
});
