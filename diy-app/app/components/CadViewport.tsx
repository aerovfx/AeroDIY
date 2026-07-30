"use client";

import type { ScenePrimitive } from "@/lib/cad-engine";
import { flowVelocityAt, pressureCoefficient, traceStreamline } from "@/lib/cfd-flow-field";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

type CadViewportProps = {
  sceneSpec: ScenePrimitive[];
  view: "iso" | "top" | "front";
  exploded: boolean;
  resetToken: number;
  pitchDeg?: number;
  flowDomain?: {
    enabled: boolean;
    velocityMs: number;
    showStreamlines?: boolean;
    showPressure?: boolean;
    showDomain?: boolean;
    showParticles?: boolean;
    particleCount?: number;
    resultVariable?: "velocity" | "pressure" | "vorticity";
  };
};

function addEdges(mesh: THREE.Mesh, color = 0xb9c1b8) {
  const edges = new THREE.EdgesGeometry(mesh.geometry);
  const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.72 }));
  mesh.add(line);
}

function material(color: THREE.ColorRepresentation, opacity = 1, metalness = 0.08, roughness = 0.52, map?: THREE.Texture) {
  const options: THREE.MeshStandardMaterialParameters = { color, opacity, transparent: opacity < 1, metalness, roughness, fog: false };
  if (map) options.map = map;
  return new THREE.MeshStandardMaterial(options);
}

function carbonTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.fillStyle = "#242625";
  context.fillRect(0, 0, 64, 64);
  context.lineWidth = 2;
  for (let offset = -64; offset < 128; offset += 8) {
    context.strokeStyle = "rgba(255,255,255,.055)";
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(offset + 64, 64);
    context.stroke();
    context.strokeStyle = "rgba(0,0,0,.18)";
    context.beginPath();
    context.moveTo(offset + 4, 0);
    context.lineTo(offset - 60, 64);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function plateGeometry(size: [number, number, number]) {
  const [width, thickness, depth] = size;
  const shape = new THREE.Shape();
  shape.moveTo(-width * 0.34, -depth * 0.5);
  shape.bezierCurveTo(-width * 0.47, -depth * 0.5, -width * 0.5, -depth * 0.38, -width * 0.47, -depth * 0.28);
  shape.lineTo(-width * 0.39, -depth * 0.08);
  shape.bezierCurveTo(-width * 0.37, -depth * 0.03, -width * 0.37, depth * 0.03, -width * 0.39, depth * 0.08);
  shape.lineTo(-width * 0.47, depth * 0.28);
  shape.bezierCurveTo(-width * 0.5, depth * 0.38, -width * 0.47, depth * 0.5, -width * 0.34, depth * 0.5);
  shape.lineTo(width * 0.34, depth * 0.5);
  shape.bezierCurveTo(width * 0.47, depth * 0.5, width * 0.5, depth * 0.38, width * 0.47, depth * 0.28);
  shape.lineTo(width * 0.39, depth * 0.08);
  shape.bezierCurveTo(width * 0.37, depth * 0.03, width * 0.37, -depth * 0.03, width * 0.39, -depth * 0.08);
  shape.lineTo(width * 0.47, -depth * 0.28);
  shape.bezierCurveTo(width * 0.5, -depth * 0.38, width * 0.47, -depth * 0.5, width * 0.34, -depth * 0.5);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.7, bevelThickness: 0.45, curveSegments: 16 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, thickness / 2, 0);
  return geometry;
}

function roundedBox(size: [number, number, number], radius = 1.2) {
  return new RoundedBoxGeometry(size[0], size[1], size[2], 4, Math.min(radius, size[0] / 4, size[1] / 4, size[2] / 4));
}

function makePropeller(primitive: ScenePrimitive) {
  const group = new THREE.Group();
  const length = primitive.size[0] / 2;
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, -2.2);
  bladeShape.bezierCurveTo(length * 0.28, -5.2, length * 0.72, -6.1, length, -1.2);
  bladeShape.bezierCurveTo(length * 0.72, 1.8, length * 0.26, 3.8, 0, 2.2);
  bladeShape.closePath();
  const bladeGeometry = new THREE.ExtrudeGeometry(bladeShape, { depth: 1.2, bevelEnabled: true, bevelSize: 0.35, bevelThickness: 0.25, bevelSegments: 2, curveSegments: 12 });
  bladeGeometry.rotateX(Math.PI / 2);
  bladeGeometry.translate(0, 0.6, 0);
  // Pattern hangar của Pidron: phần quay nằm trong MỘT group con (spinner) để
  // vòng animate chỉ việc xoay quanh trục Y cục bộ — mọi rotation/position của
  // primitive cha (kể cả cánh đẩy nằm ngang) tự đúng theo phân cấp scene graph.
  const spinner = new THREE.Group();
  [0, Math.PI].forEach((angle) => {
    const blade = new THREE.Mesh(bladeGeometry, material(primitive.color, 1, 0.15, 0.48));
    blade.rotation.y = angle;
    blade.castShadow = true;
    spinner.add(blade);
  });
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(5, 5.5, 2.8, 32), material("#262827", 1, 0.4, 0.3));
  hub.position.y = 0.7;
  hub.castShadow = true;
  spinner.add(hub);
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 3.4, 6), material("#d2d4d2", 1, 0.88, 0.2));
  nut.position.y = 3;
  spinner.add(nut);
  // Pha khởi đầu lệch nhau giữa các cánh (mẹo Pidron) nhưng TIỀN ĐỊNH theo id —
  // extractor voxel hoá cùng mesh này, dùng Math.random() là bóng collision đổi
  // theo từng lần chạy (đo được: solidCells nhảy 2002↔2063 giữa hai lần mở).
  let phase = 0;
  for (let index = 0; index < primitive.id.length; index += 1) phase = (phase * 31 + primitive.id.charCodeAt(index)) >>> 0;
  spinner.rotation.y = (phase % 628) / 100;
  group.add(spinner);
  // Đĩa motion-blur: chỉ hiện ở chế độ bay, khi mắt không còn bám kịp cánh.
  const blurDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(length, length, 0.9, 40),
    new THREE.MeshBasicMaterial({ color: primitive.color, transparent: true, opacity: 0.16, depthWrite: false }),
  );
  blurDisc.position.y = 0.8;
  blurDisc.visible = false;
  // Đĩa blur là Mesh thật — nếu không loại trừ, voxelizer sẽ biến nó thành đĩa
  // ĐẶC chắn dòng tại mỗi rotor và Cd đội lên trong im lặng.
  blurDisc.userData.noCollision = true;
  group.add(blurDisc);
  group.userData.propSpinner = spinner;
  group.userData.propBlurDisc = blurDisc;
  return group;
}

function makeMotor(primitive: ScenePrimitive) {
  const group = new THREE.Group();
  const radius = primitive.size[0];
  const base = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.06, 4.2, 32), material("#202221", 1, 0.55, 0.28));
  base.position.y = -primitive.size[1] * 0.3;
  group.add(base);
  const stator = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.62, 1.25, 8, 32), material("#b96b32", 1, 0.62, 0.32));
  stator.rotation.x = Math.PI / 2;
  stator.position.y = 0.4;
  group.add(stator);
  for (let index = 0; index < 12; index += 1) {
    const angle = index / 12 * Math.PI * 2;
    const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 3.6, 8), material(index % 2 ? "#d68741" : "#a9572a", 1, 0.5, 0.35));
    coil.position.set(Math.cos(angle) * radius * 0.62, 0.2, Math.sin(angle) * radius * 0.62);
    coil.rotation.z = Math.PI / 2;
    coil.rotation.y = -angle;
    group.add(coil);
  }
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.82, 7.5, 32, 1, true), material("#313332", 1, 0.68, 0.22));
  bell.position.y = 2.5;
  group.add(bell);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 10, 20), material("#d7d9d7", 1, 0.9, 0.16));
  shaft.position.y = 5.6;
  group.add(shaft);
  group.traverse((child) => { if (child instanceof THREE.Mesh) child.castShadow = true; });
  return group;
}

function makePcb(primitive: ScenePrimitive) {
  const group = new THREE.Group();
  const board = new THREE.Mesh(roundedBox(primitive.size, 1.6), material(primitive.color, 1, 0.05, 0.55));
  board.castShadow = true;
  group.add(board);
  const top = primitive.size[1] / 2;
  const chipSizes: Array<[number, number, number, number]> = [[0, 0, 12, 10], [-12, 8, 7, 5], [12, -7, 8, 6], [10, 10, 5, 4]];
  chipSizes.forEach(([x, z, width, depth], index) => {
    const chip = new THREE.Mesh(roundedBox([width, 2.2 + index * 0.2, depth], 0.5), material(index === 3 ? "#c6c8c4" : "#171918", 1, index === 3 ? 0.65 : 0.12, 0.34));
    chip.position.set(x * primitive.size[0] / 44, top + 1.4, z * primitive.size[2] / 44);
    chip.castShadow = true;
    group.add(chip);
  });
  for (let index = 0; index < 12; index += 1) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.5, 3.2), material("#d2b36c", 1, 0.75, 0.28));
    const side = index < 6 ? -1 : 1;
    pad.position.set(side * (primitive.size[0] / 2 - 2.4), top + 0.45, ((index % 6) - 2.5) * primitive.size[2] / 7);
    group.add(pad);
  }
  return group;
}

function makeBattery(primitive: ScenePrimitive) {
  const group = new THREE.Group();
  for (let index = -1; index <= 1; index += 1) {
    const cell = new THREE.Mesh(roundedBox([primitive.size[0] / 3 - 1, primitive.size[1], primitive.size[2]], 2.2), material("#1f2020", 1, 0.08, 0.72));
    cell.position.x = index * primitive.size[0] / 3;
    cell.castShadow = true;
    group.add(cell);
    const marker = new THREE.Mesh(new THREE.BoxGeometry(primitive.size[0] / 3 - 4, primitive.size[1] * 0.58, 0.8), material("#d9403d", 1, 0.05, 0.5));
    marker.position.set(index * primitive.size[0] / 3, 0, primitive.size[2] / 2 + 0.45);
    group.add(marker);
  }
  const strap = new THREE.Mesh(new THREE.BoxGeometry(9, primitive.size[1] + 1.5, primitive.size[2] + 2), material("#101111", 1, 0.04, 0.84));
  strap.rotation.z = Math.PI / 2;
  group.add(strap);
  return group;
}

function makeScrew(primitive: ScenePrimitive) {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(primitive.size[0] * 0.52, primitive.size[0] * 0.52, primitive.size[1], 16), material(primitive.color, 1, 0.9, 0.18));
  group.add(shaft);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(primitive.size[0] * 1.25, primitive.size[0] * 1.25, 2.4, 6), material("#d9dbd9", 1, 0.92, 0.16));
  head.position.y = primitive.size[1] / 2 + 1.2;
  group.add(head);
  return group;
}

function wingGeometry(size: [number, number, number], profile?: Array<[number, number]>) {
  // size = [span, thickness, chord]. Builds a tapered membrane/wing planform in the
  // span(X)-chord(Z) plane, extruded by thickness along Y. Reads as an insect/ornithopter
  // wing at low thickness and as a UAV wing panel at higher thickness.
  const [span, thickness, chord] = size;
  const shape = new THREE.Shape();
  if (profile && profile.length >= 3) {
    shape.moveTo(profile[0][0], profile[0][1]);
    for (let i = 1; i < profile.length; i += 1) shape.lineTo(profile[i][0], profile[i][1]);
    shape.closePath();
  } else {
    // Leading edge sweeps out then tapers to a rounded tip; trailing edge curves back.
    shape.moveTo(0, -chord * 0.5);
    shape.bezierCurveTo(span * 0.25, -chord * 0.62, span * 0.7, -chord * 0.5, span, -chord * 0.12);
    shape.bezierCurveTo(span * 1.02, -chord * 0.02, span * 1.02, chord * 0.06, span, chord * 0.16);
    shape.bezierCurveTo(span * 0.68, chord * 0.42, span * 0.28, chord * 0.5, 0, chord * 0.5);
    shape.closePath();
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(thickness, 0.3), bevelEnabled: true, bevelSize: Math.min(thickness * 0.4, 0.5), bevelThickness: Math.min(thickness * 0.4, 0.4), bevelSegments: 1, curveSegments: 20 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, thickness / 2, 0);
  return geometry;
}

function latheGeometry(size: [number, number, number], profile?: Array<[number, number]>) {
  // Revolve a [radius, height] profile around the Y axis. Great for nozzles, domes,
  // canisters, bottles, wheels and rounded pods.
  const [radius, height] = size;
  const pts = (profile && profile.length >= 2 ? profile : [[0.05, 0], [1, 0.05], [0.9, 0.5], [1, 0.95], [0.05, 1]])
    .map(([r, h]) => new THREE.Vector2(Math.max(r * radius, 0.01), (h - 0.5) * height));
  return new THREE.LatheGeometry(pts, 40);
}

function makeTube(primitive: ScenePrimitive) {
  // Hollow cylinder: outer radius size[0], height size[1], inner radius size[2].
  const [outer, height, inner] = primitive.size;
  const inR = Math.min(inner > 0 ? inner : outer * 0.6, outer * 0.95);
  const profile: Array<[number, number]> = [[inR / outer, 0], [1, 0], [1, 1], [inR / outer, 1], [inR / outer, 0]];
  const mesh = new THREE.Mesh(latheGeometry([outer, height, 0], profile), material(primitive.color, primitive.opacity ?? 1, primitive.role === "mount" ? 0.72 : 0.3, 0.42));
  mesh.castShadow = true;
  return mesh;
}

function makePrimitive(primitive: ScenePrimitive, carbon?: THREE.Texture) {
  if (primitive.kind === "motor") return makeMotor(primitive);
  if (primitive.kind === "propeller") return makePropeller(primitive);
  if (primitive.kind === "pcb") return makePcb(primitive);
  if (primitive.kind === "battery") return makeBattery(primitive);
  if (primitive.kind === "screw") return makeScrew(primitive);
  if (primitive.kind === "tube") return makeTube(primitive);
  if (primitive.kind === "wire" && primitive.points) {
    const curve = new THREE.CatmullRomCurve3(primitive.points.map((point) => new THREE.Vector3(...point)));
    const wire = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, primitive.size[0], 8, false), material(primitive.color, 1, 0.05, 0.62));
    wire.castShadow = true;
    return wire;
  }
  const geometry = primitive.kind === "plate"
    ? plateGeometry(primitive.size)
    : primitive.kind === "wing"
      ? wingGeometry(primitive.size, primitive.profile)
      : primitive.kind === "lathe"
        ? latheGeometry(primitive.size, primitive.profile)
        : primitive.kind === "sphere"
          ? new THREE.SphereGeometry(primitive.size[0], 32, 24)
          : primitive.kind === "cone"
            ? new THREE.ConeGeometry(primitive.size[0], primitive.size[1], 32)
            : primitive.kind === "box"
              ? roundedBox(primitive.size, primitive.role === "enclosure" ? 1.1 : 0.8)
              : new THREE.CylinderGeometry(primitive.size[0], primitive.size[2], primitive.size[1], 32);
  const mesh = new THREE.Mesh(geometry, material(primitive.color, primitive.opacity ?? 1, primitive.role === "mount" ? 0.72 : 0.18, primitive.role === "enclosure" ? 0.34 : 0.5, primitive.role === "enclosure" ? carbon : undefined));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  addEdges(mesh, primitive.role === "mount" ? 0x707572 : 0x4f5351);
  return mesh;
}

/**
 * Trích tam giác world-space (mm, y hướng lên) của scene CAD — ĐÚNG các mesh mà
 * viewport render (RoundedBox, lathe, wing profile, propeller…), phục vụ
 * `voxelizeMeshMm` của solver 3D. Đây là đường "collision" thật: dòng chảy va
 * vào bề mặt người dùng nhìn thấy, không phải hộp bao primitive.
 *
 * Dùng lại `makePrimitive` + đúng logic đặt vị trí của viewport (không exploded,
 * không pitch — góc tấn do voxelizer xoay). Bỏ qua các phần không ảnh hưởng
 * dòng ở cỡ lưới này: dây, vít, cutout, vật gần trong suốt (vd vòng bảo vệ).
 */
export function extractAssemblyTrianglesMm(sceneSpec: ScenePrimitive[]): Float32Array {
  const assembly = new THREE.Group();
  const kept: ScenePrimitive[] = sceneSpec.filter((primitive) =>
    primitive.kind !== "wire" && primitive.kind !== "screw" && primitive.role !== "cutout"
    && !(primitive.opacity !== undefined && primitive.opacity < 0.35));
  for (const primitive of kept) {
    const object = makePrimitive(primitive);
    object.position.set(...primitive.position);
    if (primitive.rotation) object.rotation.set(...primitive.rotation);
    assembly.add(object);
  }
  assembly.updateMatrixWorld(true);

  const chunks: Float32Array[] = [];
  let total = 0;
  assembly.traverse((object) => {
    // Chỉ lấy Mesh — LineSegments của addEdges không phải bề mặt.
    if (!(object instanceof THREE.Mesh)) return;
    if (object.userData.noCollision) return; // đĩa motion-blur chỉ là hiệu ứng
    const world = object.geometry.clone().applyMatrix4(object.matrixWorld);
    const unindexed = world.index ? world.toNonIndexed() : world;
    const positions = unindexed.getAttribute("position").array as Float32Array;
    chunks.push(Float32Array.from(positions));
    total += positions.length;
    world.dispose();
    if (unindexed !== world) unindexed.dispose();
  });
  const triangles = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { triangles.set(chunk, offset); offset += chunk.length; }
  return triangles;
}

/** Dựng group hiển thị cho hầm gió 3D — cùng bộ lọc với extractor để mesh nhìn thấy = mesh va chạm. */
export function buildFlowAssembly(sceneSpec: ScenePrimitive[]): THREE.Group {
  const assembly = new THREE.Group();
  for (const primitive of sceneSpec) {
    if (primitive.kind === "wire" || primitive.kind === "screw" || primitive.role === "cutout") continue;
    if (primitive.opacity !== undefined && primitive.opacity < 0.35) continue;
    const object = makePrimitive(primitive);
    object.position.set(...primitive.position);
    if (primitive.rotation) object.rotation.set(...primitive.rotation);
    assembly.add(object);
  }
  return assembly;
}

export function CadViewport({ sceneSpec, view, exploded, resetToken, pitchDeg = 0, flowDomain }: CadViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xd9dad8);
    scene.fog = new THREE.FogExp2(0xd9dad8, 0.00055);

    const maxExtent = sceneSpec.reduce((max, primitive) => Math.max(max, Math.abs(primitive.position[0]) + primitive.size[0] / 2, Math.abs(primitive.position[2]) + primitive.size[2] / 2), 100);
    const cameraScale = Math.max(1, maxExtent / 64);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1200);
    const cameraPositions = {
      iso: new THREE.Vector3(120 * cameraScale, 68 * cameraScale, 135 * cameraScale),
      top: new THREE.Vector3(0, 175 * cameraScale, 0.01),
      front: new THREE.Vector3(0, 55 * cameraScale, 175 * cameraScale),
    };
    camera.position.copy(cameraPositions[view]);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute("aria-label", "Viewport CAD 3D tương tác");
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.target.set(0, 12, 0);
    controls.minDistance = 65 * cameraScale;
    controls.maxDistance = 300 * cameraScale;
    controls.maxPolarAngle = Math.PI * 0.82;

    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    scene.add(new THREE.HemisphereLight(0xf8faf8, 0x666a67, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 4.2);
    keyLight.position.set(-90, 150, 120);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xdde7ff, 2.4);
    fillLight.position.set(110, 70, -90);
    scene.add(fillLight);

    const gridSize = Math.max(260, Math.ceil(maxExtent * 2.4 / 20) * 20);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(gridSize, gridSize), new THREE.ShadowMaterial({ color: 0x747774, opacity: 0.2 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -9;
    floor.receiveShadow = true;
    scene.add(floor);

    const assembly = new THREE.Group();
    assembly.rotation.x = THREE.MathUtils.degToRad(pitchDeg);
    scene.add(assembly);
    const carbon = carbonTexture();
    sceneSpec.forEach((primitive, index) => {
      const object = makePrimitive(primitive, carbon);
      const [x, y, z] = primitive.position;
      const explodeFactor = exploded && primitive.role === "component" ? 1.7 : 1;
      object.position.set(primitive.kind === "wire" ? 0 : x * explodeFactor, primitive.kind === "wire" ? 0 : y + (exploded && primitive.role === "component" ? 22 + index * 2 : 0), primitive.kind === "wire" ? 0 : z * explodeFactor);
      if (primitive.rotation) object.rotation.set(...primitive.rotation);
      // makePropeller đã cài propSpinner/propBlurDisc vào userData — GIỮ chúng
      // khi gắn nhãn, nếu ghi đè cả object.userData là cánh ngừng quay âm thầm.
      object.userData.id = primitive.id;
      object.userData.label = primitive.label;
      assembly.add(object);
    });

    // ─ Cánh quạt quay (tham khảo hangar Pidron) ─
    // Chiều quay theo quy ước quad: cặp chéo cùng chiều — sign(x·z); cánh đơn
    // (đẩy sau của cánh bằng) rơi về +1. Chế độ: bay khi ở hầm gió CFD, quay
    // chậm ở preview để mô hình "sống", DỪNG khi exploded (đang soi linh kiện).
    type PropSpin = { spinner: THREE.Object3D; blurDisc: THREE.Object3D; direction: number };
    const propSpinners: PropSpin[] = [];
    sceneSpec.forEach((primitive, index) => {
      const object = assembly.children[index];
      if (!object?.userData.propSpinner) return;
      const direction = Math.sign(primitive.position[0] * primitive.position[2]) || (index % 2 === 0 ? 1 : -1);
      propSpinners.push({ spinner: object.userData.propSpinner, blurDisc: object.userData.propBlurDisc, direction });
    });
    const spinMode: "off" | "idle" | "flight" = exploded ? "off" : flowDomain?.enabled ? "flight" : "idle";
    const spinRate = spinMode === "flight" ? 46 : 2.6; // rad/s
    propSpinners.forEach(({ blurDisc }) => { blurDisc.visible = spinMode === "flight"; });

    const flowParticles: Array<{ mesh: THREE.Mesh; curve: THREE.CatmullRomCurve3; phase: number; speed: number }> = [];
    let popSystem: { points:THREE.Points; trails:THREE.LineSegments; positions:Float32Array; previous:Float32Array; colors:Float32Array; trailPositions:Float32Array; ages:Float32Array; lifetimes:Float32Array; count:number; domainLength:number; maxExtent:number; fieldOptions:{ velocityMs:number; angleOfAttackDeg:number; bodyRadii:[number,number,number]; timeSeconds:number } } | undefined;
    if (flowDomain?.enabled) {
      const domainLength = maxExtent * 3.6;
      const domainWidth = maxExtent * 2.1;
      const domainHeight = Math.max(100, maxExtent * 1.15);
      if (flowDomain.showDomain !== false) {
        const domainGeometry = new THREE.BoxGeometry(domainLength, domainHeight, domainWidth);
        const domain = new THREE.Mesh(domainGeometry, new THREE.MeshBasicMaterial({ color:0x2f91bf, transparent:true, opacity:0.045, side:THREE.BackSide, depthWrite:false }));
        domain.position.x = maxExtent * 0.35;
        scene.add(domain);
        const domainEdges = new THREE.LineSegments(new THREE.EdgesGeometry(domainGeometry), new THREE.LineBasicMaterial({ color:0x58b7dc, transparent:true, opacity:0.38 }));
        domainEdges.position.copy(domain.position);
        scene.add(domainEdges);
        const inlet = new THREE.Mesh(new THREE.PlaneGeometry(domainWidth, domainHeight), new THREE.MeshBasicMaterial({ color:0x2c9ed0, transparent:true, opacity:0.09, side:THREE.DoubleSide, depthWrite:false }));
        inlet.rotation.y = Math.PI / 2; inlet.position.x = -domainLength / 2 + maxExtent * 0.35; scene.add(inlet);
        const outlet = inlet.clone(); (outlet.material as THREE.MeshBasicMaterial) = new THREE.MeshBasicMaterial({ color:0xef7954, transparent:true, opacity:0.07, side:THREE.DoubleSide, depthWrite:false });
        outlet.position.x = domainLength / 2 + maxExtent * 0.35; scene.add(outlet);
      }
      if (flowDomain.showPressure !== false) {
        const high = new THREE.Mesh(new THREE.SphereGeometry(maxExtent * 0.44, 30, 20), new THREE.MeshBasicMaterial({ color:0xff4d22, transparent:true, opacity:0.16, depthWrite:false, blending:THREE.AdditiveBlending }));
        high.scale.set(0.32, 0.72, 0.8); high.position.x = -maxExtent * 0.58; scene.add(high);
        const low = new THREE.Mesh(new THREE.SphereGeometry(maxExtent * 0.58, 30, 20), new THREE.MeshBasicMaterial({ color:0x167dcc, transparent:true, opacity:0.13, depthWrite:false, blending:THREE.AdditiveBlending }));
        low.scale.set(0.8, 0.55, 0.75); low.position.x = maxExtent * 0.68; scene.add(low);
      }
      if (flowDomain.showStreamlines !== false) {
        const streamMaterial = (color: number, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent:true, opacity, depthWrite:false, blending:THREE.AdditiveBlending });
        const fieldOptions = { velocityMs:flowDomain.velocityMs, angleOfAttackDeg:pitchDeg, bodyRadii:[maxExtent * .52, Math.max(22, maxExtent * .2), maxExtent * .48] as [number, number, number], timeSeconds:0 };
        for (let row = -3; row <= 3; row += 1) for (let lane = -3; lane <= 3; lane += 1) {
          if (Math.abs(row) < 2 && Math.abs(lane) < 2) continue;
          const y = row * maxExtent * 0.16 + 8;
          const z = lane * maxExtent * 0.18;
          const proximity = Math.max(0, 1 - (Math.abs(row) + Math.abs(lane)) / 7);
          const traced = traceStreamline([-domainLength * .48, y, z], fieldOptions, domainLength * .55, Math.max(2, maxExtent * .035), 130);
          const points = traced.map((point) => new THREE.Vector3(...point));
          const curve = new THREE.CatmullRomCurve3(points);
          const sample = flowVelocityAt(traced[Math.floor(traced.length * .56)], fieldOptions);
          const normalizedSpeed = Math.max(0, Math.min(1, Math.hypot(...sample) / Math.max(flowDomain.velocityMs * 1.45, 1)));
          const lineColor = new THREE.Color().setHSL(.66 - .66 * normalizedSpeed, 1, .56).getHex();
          const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 72, Math.max(0.22, maxExtent * 0.003), 5, false), streamMaterial(lineColor, 0.38 + proximity * 0.24));
          scene.add(tube);
          const particle = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.7, maxExtent * 0.009), 8, 6), streamMaterial(lineColor, 0.9));
          scene.add(particle);
          flowParticles.push({ mesh:particle, curve, phase:((row + 3) * 7 + lane + 3) / 49, speed:0.055 + Math.max(2, flowDomain.velocityMs) * 0.0024 });
        }
      }
      if (flowDomain.showParticles !== false) {
        const count = Math.max(80, Math.min(1200, flowDomain.particleCount ?? 420));
        const positions = new Float32Array(count * 3);
        const previous = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const trailPositions = new Float32Array(count * 6);
        const ages = new Float32Array(count);
        const lifetimes = new Float32Array(count);
        const fieldOptions = { velocityMs:flowDomain.velocityMs, angleOfAttackDeg:pitchDeg, bodyRadii:[maxExtent * .52, Math.max(22, maxExtent * .2), maxExtent * .48] as [number,number,number], timeSeconds:0 };
        const seed = (index:number, randomAge = false) => {
          const offset = index * 3;
          const ring = Math.sqrt(Math.random());
          const theta = Math.random() * Math.PI * 2;
          positions[offset] = -domainLength * .49 + Math.random() * maxExtent * .16;
          positions[offset + 1] = 8 + Math.cos(theta) * ring * domainHeight * .43;
          positions[offset + 2] = Math.sin(theta) * ring * domainWidth * .43;
          previous[offset] = positions[offset]; previous[offset + 1] = positions[offset + 1]; previous[offset + 2] = positions[offset + 2];
          ages[index] = randomAge ? Math.random() * 5 : 0;
          lifetimes[index] = 4.5 + Math.random() * 3.5;
        };
        for (let index = 0; index < count; index += 1) seed(index, true);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size:Math.max(1.1,maxExtent * .012), vertexColors:true, transparent:true, opacity:.86, depthWrite:false, blending:THREE.AdditiveBlending, sizeAttenuation:true }));
        const trailGeometry = new THREE.BufferGeometry();
        trailGeometry.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
        const trails = new THREE.LineSegments(trailGeometry, new THREE.LineBasicMaterial({ color:0x78d9f4, transparent:true, opacity:.24, depthWrite:false, blending:THREE.AdditiveBlending }));
        scene.add(trails, points);
        popSystem = { points, trails, positions, previous, colors, trailPositions, ages, lifetimes, count, domainLength, maxExtent, fieldOptions };
        points.userData.seed = seed;
      }
    }

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    let frame = 0;
    const clock = new THREE.Clock();
    const particleColor = new THREE.Color();
    let lastSpinTime = performance.now() / 1000;
    const animate = () => {
      frame = window.requestAnimationFrame(animate);
      const time = performance.now() / 1000;
      if (spinMode !== "off") {
        const spinDelta = Math.min(0.05, time - lastSpinTime);
        for (const { spinner, direction } of propSpinners) spinner.rotation.y += direction * spinRate * spinDelta;
      }
      lastSpinTime = time;
      flowParticles.forEach((particle) => particle.mesh.position.copy(particle.curve.getPointAt((particle.phase + time * particle.speed) % 1)));
      if (popSystem) {
        const delta = Math.min(.032, clock.getDelta());
        popSystem.fieldOptions.timeSeconds = time;
        const seed = popSystem.points.userData.seed as (index:number) => void;
        for (let index = 0; index < popSystem.count; index += 1) {
          const offset = index * 3;
          popSystem.ages[index] += delta;
          const point:[number,number,number] = [popSystem.positions[offset],popSystem.positions[offset + 1],popSystem.positions[offset + 2]];
          const velocity = flowVelocityAt(point, popSystem.fieldOptions);
          const speed = Math.hypot(...velocity);
          const stepScale = delta * popSystem.maxExtent * .075 / Math.max(popSystem.fieldOptions.velocityMs, 1);
          popSystem.previous[offset] = point[0]; popSystem.previous[offset + 1] = point[1]; popSystem.previous[offset + 2] = point[2];
          popSystem.positions[offset] += velocity[0] * stepScale;
          popSystem.positions[offset + 1] += velocity[1] * stepScale;
          popSystem.positions[offset + 2] += velocity[2] * stepScale;
          if (popSystem.positions[offset] > popSystem.domainLength * .57 || popSystem.ages[index] > popSystem.lifetimes[index] || Math.abs(popSystem.positions[offset + 1]) > popSystem.maxExtent * 1.25 || Math.abs(popSystem.positions[offset + 2]) > popSystem.maxExtent * 1.4) seed(index);
          if (flowDomain.resultVariable === "pressure") {
            const radius = Math.max(Math.hypot(point[0],point[1],point[2]),.001);
            const cp = pressureCoefficient([point[0] / radius,point[1] / radius,point[2] / radius], pitchDeg);
            const t = (cp + 1.2) / 2.2;
            particleColor.setRGB(t < .5 ? .2 + t * 1.6 : 1, t < .5 ? .35 + t * 1.3 : 1 - (t - .5) * 1.25, t < .5 ? 1 : 1 - (t - .5) * 1.7);
          } else if (flowDomain.resultVariable === "vorticity") {
            const curlProxy = Math.min(1, Math.hypot(velocity[1],velocity[2]) / Math.max(popSystem.fieldOptions.velocityMs * .45,1));
            particleColor.setHSL(.78 - curlProxy * .78,1,.58);
          } else particleColor.setHSL(.68 - Math.min(1, speed / Math.max(popSystem.fieldOptions.velocityMs * 1.6, 1)) * .68, 1, .58);
          popSystem.colors[offset] = particleColor.r; popSystem.colors[offset + 1] = particleColor.g; popSystem.colors[offset + 2] = particleColor.b;
          const trail = index * 6;
          popSystem.trailPositions[trail] = popSystem.previous[offset]; popSystem.trailPositions[trail + 1] = popSystem.previous[offset + 1]; popSystem.trailPositions[trail + 2] = popSystem.previous[offset + 2];
          popSystem.trailPositions[trail + 3] = popSystem.positions[offset]; popSystem.trailPositions[trail + 4] = popSystem.positions[offset + 1]; popSystem.trailPositions[trail + 5] = popSystem.positions[offset + 2];
        }
        (popSystem.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        (popSystem.points.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
        (popSystem.trails.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
        if (object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
        if (object instanceof THREE.Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      carbon?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [sceneSpec, view, exploded, resetToken, pitchDeg, flowDomain?.enabled, flowDomain?.velocityMs, flowDomain?.showStreamlines, flowDomain?.showPressure, flowDomain?.showDomain, flowDomain?.showParticles, flowDomain?.particleCount, flowDomain?.resultVariable]);

  return <div className="three-viewport" ref={mountRef} />;
}
