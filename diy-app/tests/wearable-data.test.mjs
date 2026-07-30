import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EXO_SUIT,
  buildExoSuitCadProject,
  exoSuitElectricalConnections,
  exoSuitInstructionSteps,
  exoSuitMechanicalConnections,
  exoSuitParts,
} from "../dist-mcp/lib/exo-suit-data.js";
import {
  LIFT_BOOT,
  buildLiftBootCadProject,
  liftBootElectricalConnections,
  liftBootInstructionSteps,
  liftBootMechanicalConnections,
  liftBootParts,
} from "../dist-mcp/lib/lift-boot-data.js";

test("civilian exoskeleton exports a complete, non-weapon wearable project", () => {
  const cad = buildExoSuitCadProject();
  assert.equal(EXO_SUIT.key, "exosuit");
  assert.equal(EXO_SUIT.componentCount, exoSuitParts.length);
  assert.ok(exoSuitElectricalConnections.length >= 10);
  assert.ok(exoSuitMechanicalConnections.length >= 8);
  assert.ok(exoSuitInstructionSteps.length >= 4);
  assert.equal(cad.validation.passed, true);
  assert.ok(cad.scene.some((primitive) => primitive.id === "knee-l"));
  assert.doesNotMatch(JSON.stringify({ parts: exoSuitParts, cad }), /projectile launcher|breech|ballistic armor/i);
});

test("hydraulic lift boot exports pumps, four cylinders and wearable safety gates", () => {
  const cad = buildLiftBootCadProject();
  assert.equal(LIFT_BOOT.key, "liftboot");
  assert.equal(LIFT_BOOT.componentCount, liftBootParts.length);
  assert.equal(cad.scene.filter((primitive) => primitive.id.startsWith("cyl-")).length, 4);
  assert.equal(cad.scene.filter((primitive) => primitive.kind === "motor").length, 2);
  assert.ok(cad.scene.some((primitive) => primitive.kind === "lathe"));
  assert.ok(liftBootElectricalConnections.length >= 6);
  assert.ok(liftBootMechanicalConnections.length >= 7);
  assert.ok(liftBootInstructionSteps.some((section) => section.id === "bringup"));
  assert.match(cad.validation.issues.map((issue) => issue.message).join(" "), /bench-test|unworn|Pinch/i);
});

test("both wearable modes are selectable and routed through the page workflow", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // Bộ chọn dự án render theo dữ liệu: mọi template đều đi qua cùng một
  // handler `selectProject(item.mode)`, nên không có lời gọi literal
  // `selectProject("exosuit")` nào trong nguồn. Một mode "chọn được" nghĩa là:
  //   1. có mặt trong projectTemplates (nút hiện ra trong picker),
  //   2. selectProject route được sang builder CAD của nó,
  //   3. luồng tạo lại theo prompt + version cũng route sang builder đó.
  assert.match(page, /onClick=\{\(\) => selectProject\(item\.mode\)\}/, "picker phải wire mọi template qua selectProject(item.mode)");

  const builders = { exosuit: "buildExoSuitCadProject", liftboot: "buildLiftBootCadProject" };
  for (const [mode, builder] of Object.entries(builders)) {
    assert.match(page, new RegExp(`mode:\\s*"${mode}"`), `${mode} phải có trong projectTemplates`);
    assert.match(page, new RegExp(`mode === "${mode}" \\? ${builder}\\(\\)`), `selectProject phải route ${mode} sang ${builder}()`);
    assert.match(page, new RegExp(`projectMode === "${mode}"`), `luồng tạo lại phải có nhánh cho ${mode}`);
    assert.match(page, new RegExp(`${builder}\\(value, version\\)`), `${mode} phải dựng lại được theo prompt + version`);
  }
});
