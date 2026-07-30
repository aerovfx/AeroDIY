export type FlowVector = [number, number, number];

export type FlowFieldOptions = {
  velocityMs: number;
  angleOfAttackDeg: number;
  bodyRadii: FlowVector;
  timeSeconds?: number;
  strouhalNumber?: number;
};

const magnitude = ([x, y, z]: FlowVector) => Math.hypot(x, y, z);

/**
 * Fast educational 3D flow-field proxy derived from the Aeroedu Vision AI
 * potential-flow model: uniform flow + ellipsoid doublet + boundary-layer
 * slowdown + a decaying von Karman wake. Coordinates use X as freestream.
 */
export function flowVelocityAt([x, y, z]: FlowVector, options: FlowFieldOptions): FlowVector {
  const [rx, ry, rz] = options.bodyRadii.map((value) => Math.max(value, 0.01)) as FlowVector;
  const speed = Math.max(options.velocityMs, 0.1);
  const angle = options.angleOfAttackDeg * Math.PI / 180;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let vx = speed * ux;
  let vy = speed * uy;
  let vz = 0;

  const nx = x / rx;
  const ny = y / ry;
  const nz = z / rz;
  const ellipsoidDistance = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const radius = (rx + ry + rz) / 3;
  const r = Math.max(Math.hypot(x, y, z), radius * 0.22);

  if (ellipsoidDistance > 0.96) {
    const strength = Math.min(0.78, (radius ** 3) / (2 * r ** 3));
    const dot = ux * x / r + uy * y / r;
    vx += speed * strength * (3 * dot * x / r - ux);
    vy += speed * strength * (3 * dot * y / r - uy);
    vz += speed * strength * (3 * dot * z / r);
  } else {
    const escape = speed * (1.05 - ellipsoidDistance);
    vx += x / r * escape;
    vy += y / r * escape;
    vz += z / r * escape;
  }

  // Blasius-inspired boundary layer: slow the tangential flow close to body.
  if (ellipsoidDistance > 0.96 && ellipsoidDistance < 1.35 && x > -rx) {
    const layer = Math.max(0.18, (ellipsoidDistance - 0.96) / 0.39);
    vx *= layer;
    vy *= layer;
    vz *= layer;
  }

  // Alternating, convecting Karman vortices downstream (St ≈ 0.2).
  if (x > rx * 0.45) {
    const downstream = x - rx * 0.45;
    const wakeRadius = ry * (1.15 + downstream / Math.max(rx * 7, 0.1));
    const radial = Math.hypot(y, z);
    if (radial < wakeRadius * 2.2) {
      const decay = Math.exp(-downstream / Math.max(rx * 6, 0.1));
      const frequency = (options.strouhalNumber ?? 0.2) * speed / Math.max(2 * ry, 0.1);
      const phase = frequency * (options.timeSeconds ?? 0) * Math.PI * 2 - downstream / Math.max(rx * 0.7, 0.1);
      const envelope = Math.exp(-(radial * radial) / Math.max(wakeRadius * wakeRadius, 0.01));
      vy += speed * 0.34 * decay * envelope * Math.sin(phase);
      vz += speed * 0.18 * decay * envelope * Math.cos(phase * 0.8);
      if (downstream < rx * 2.4) vx -= speed * 0.28 * decay * envelope;
    }
  }
  return [vx, vy, vz];
}

export function traceStreamline(seed: FlowVector, options: FlowFieldOptions, domainEndX: number, stepLength: number, maxSteps = 120): FlowVector[] {
  const points: FlowVector[] = [seed];
  let point: FlowVector = [...seed];
  for (let step = 0; step < maxSteps && point[0] < domainEndX; step += 1) {
    const first = flowVelocityAt(point, options);
    const firstMag = Math.max(magnitude(first), 0.001);
    const mid: FlowVector = [point[0] + first[0] / firstMag * stepLength * 0.5, point[1] + first[1] / firstMag * stepLength * 0.5, point[2] + first[2] / firstMag * stepLength * 0.5];
    const second = flowVelocityAt(mid, options);
    const secondMag = Math.max(magnitude(second), 0.001);
    point = [point[0] + second[0] / secondMag * stepLength, point[1] + second[1] / secondMag * stepLength, point[2] + second[2] / secondMag * stepLength];
    points.push(point);
  }
  return points;
}

export function pressureCoefficient(normal: FlowVector, angleOfAttackDeg: number) {
  const angle = angleOfAttackDeg * Math.PI / 180;
  const dot = normal[0] * Math.cos(angle) + normal[1] * Math.sin(angle);
  const coefficient = dot >= 0 ? 1 - 4 * (1 - dot * dot) : -0.35 * (1 - dot * dot);
  return Math.max(-1.2, Math.min(1, coefficient));
}
