import assert from "node:assert/strict";
import test from "node:test";
import { flowVelocityAt, pressureCoefficient, traceStreamline } from "../dist-mcp/lib/cfd-flow-field.js";

const options = { velocityMs: 15, angleOfAttackDeg: 0, bodyRadii: [1.5, .5, 1] };

test("flow field returns freestream far upstream and slows near the body", () => {
  const upstream = flowVelocityAt([-20, 4, 4], options);
  const boundary = flowVelocityAt([0, .55, 0], options);
  assert.ok(Math.abs(upstream[0] - 15) < .2);
  assert.ok(Math.hypot(...boundary) < Math.hypot(...upstream));
});

test("streamline integration crosses the domain and deflects around the body", () => {
  const line = traceStreamline([-5, .52, 0], options, 6, .12);
  assert.ok(line.length > 40);
  assert.ok(line.at(-1)[0] > 5);
  assert.ok(Math.max(...line.map((point) => Math.abs(point[1]))) > .52);
});

test("pressure coefficient distinguishes stagnation and suction zones", () => {
  assert.ok(pressureCoefficient([1, 0, 0], 0) > pressureCoefficient([0, 1, 0], 0));
});
