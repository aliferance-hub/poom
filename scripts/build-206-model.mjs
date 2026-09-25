// ─────────────────────────────────────────────────────────────────────────────
// POOM — Peugeot 206 engineering model (in-repo original, procedural)
// ─────────────────────────────────────────────────────────────────────────────
// Builds `public/models/peugeot-206-engineering-v1.glb`: a dimension-informed
// 3D model of the 206 with every Asset-Contract mesh present under its exact
// contract name (8 zones + 5 parts), so the viewer's RealModel layer resolves
// all of them and no placeholder remains.
//
// Dimension basis (public specs, meters):
//   length 3.835 · width 1.652 · height 1.425 · wheelbase 2.435
//   track ≈ 1.42 · tires 185/55R15 → rolling radius ≈ 0.285
//   front axle z = +1.22 · rear axle z = −1.22 · front of car = +z
//   radiator 206: ~600×380mm core · battery 55Ah: 242×175×190mm
//   front brake disc: ⌀266mm · oil filter: ⌀76×90mm
//
// License: POOM_IN_HOUSE — generated entirely by this script; no third-party
// asset, no downloaded geometry, no texture. Regenerate after edits:
//   node scripts/build-206-model.mjs
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Same public/ layout the admin upload route writes (uploads/assets/<assetId>/vN/),
// so an uploaded replacement later is a pure data operation.
const OUT = join(ROOT, "public", "uploads", "assets", "peugeot-206-main-v1", "v2", "peugeot-206-engineering-v1.glb");

// ── palette (vertex colors; one shared material) ──
const C = {
  paint: [0.84, 0.86, 0.89],      // 206 silver
  paintDark: [0.72, 0.75, 0.79],
  glass: [0.13, 0.15, 0.18],
  trim: [0.16, 0.17, 0.20],
  tire: [0.07, 0.07, 0.08],
  rim: [0.78, 0.79, 0.82],
  steel: [0.60, 0.63, 0.67],
  engine: [0.55, 0.57, 0.60],
  engineDark: [0.24, 0.26, 0.29],
  radiator: [0.16, 0.18, 0.21],
  radiatorFin: [0.24, 0.27, 0.31],
  tank: [0.91, 0.92, 0.94],
  hose: [0.10, 0.10, 0.11],
  fan: [0.30, 0.32, 0.36],
  battery: [0.12, 0.13, 0.15],
  batteryTop: [0.24, 0.26, 0.29],
  terminalPos: [0.75, 0.22, 0.17],
  terminalNeg: [0.84, 0.85, 0.87],
  filterOrange: [0.95, 0.38, 0.05],
  pad: [0.35, 0.37, 0.40],
  caliper: [0.88, 0.36, 0.12],    // signal orange — the caliper wears the motif
  seat: [0.17, 0.19, 0.23],
  dash: [0.14, 0.16, 0.19],
  mat: [0.09, 0.10, 0.12],
  headlight: [0.94, 0.95, 0.97],
  taillight: [0.70, 0.15, 0.11],
  grille: [0.11, 0.12, 0.14],
};

// ── helpers ──
function colored(geo, color, matrix) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (matrix) g.applyMatrix4(matrix);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i*3] = color[0]; arr[i*3+1] = color[1]; arr[i*3+2] = color[2]; }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute("uv");
  return g;
}
const M = {
  t: (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z),
  r: (x, y, z) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x, y, z)),
  s: (x, y, z) => new THREE.Matrix4().makeScale(x, y, z),
  mul: (...ms) => ms.reduce((a, b) => new THREE.Matrix4().multiplyMatrices(a, b)),
};
function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
function cyl(rt, rb, h, seg = 24) { return new THREE.CylinderGeometry(rt, rb, h, seg); }

// ── zone_body: extruded 206 side silhouette + glass + lights + arches + trim ──
function buildBody() {
  const parts = [];
  // side profile: (x = longitudinal +z-front, y = up). Extrude across width.
  const s = new THREE.Shape();
  s.moveTo(-1.90, 0.42);           // rear bumper bottom
  s.lineTo(-1.94, 0.72);           // rear bumper face
  s.lineTo(-1.86, 0.98);           // tailgate lower
  s.lineTo(-1.40, 1.385);          // hatch slope → roof
  s.lineTo(-0.18, 1.425);          // roof peak (206 roof sits forward)
  s.lineTo(0.52, 1.10);            // windshield base
  s.lineTo(1.52, 0.985);           // hood
  s.lineTo(1.86, 0.87);            // nose
  s.lineTo(1.90, 0.55);            // front bumper face
  s.lineTo(1.84, 0.40);            // front bumper bottom
  s.lineTo(-1.90, 0.42);           // rocker line (closed)
  const g = new THREE.ExtrudeGeometry(s, { depth: 1.50, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3, steps: 1 });
  g.rotateY(-Math.PI / 2);          // extrusion (z) → width (−x); shape x → +z
  g.translate(0.80, 0, 0);          // center width: −0.80 … +0.80 (+bevel)
  parts.push(colored(g, C.paint));

  // greenhouse glass (slightly proud of the beveled body)
  const ws = box(1.34, 0.60, 0.03);
  ws.applyMatrix4(M.mul(M.t(0, 1.16, 0.42), M.r(0.48, 0, 0)));
  parts.push(colored(ws, C.glass));
  const rw = box(1.28, 0.48, 0.03);
  rw.applyMatrix4(M.mul(M.t(0, 1.14, -1.46), M.r(-0.62, 0, 0)));
  parts.push(colored(rw, C.glass));
  for (const side of [-1, 1]) {
    const sw = box(0.02, 0.38, 1.46);
    sw.translate(side * 0.845, 1.18, -0.30);
    parts.push(colored(sw, C.glass));
    // door mirror
    const mir = box(0.05, 0.09, 0.15);
    mir.translate(side * 0.88, 1.02, 0.50);
    parts.push(colored(mir, C.trim));
    // rocker sill
    const sill = box(0.03, 0.10, 2.10);
    sill.translate(side * 0.83, 0.42, -0.1);
    parts.push(colored(sill, C.trim));
    // wheel-arch brows
    for (const az of [1.22, -1.22]) {
      const arch = new THREE.TorusGeometry(0.37, 0.035, 10, 24, Math.PI);
      arch.rotateY(-Math.PI / 2);
      arch.translate(side * 0.84, 0.30, az);
      parts.push(colored(arch, C.trim));
    }
  }
  // grille + lights + bumpers
  const grille = box(0.92, 0.13, 0.04); grille.translate(0, 0.80, 1.93); parts.push(colored(grille, C.grille));
  const chrome = box(0.96, 0.02, 0.045); chrome.translate(0, 0.885, 1.93); parts.push(colored(chrome, C.rim));
  for (const side of [-1, 1]) {
    const hl = box(0.36, 0.11, 0.06); hl.translate(side * 0.54, 0.905, 1.90); parts.push(colored(hl, C.headlight));
    const tl = box(0.32, 0.13, 0.05); tl.translate(side * 0.54, 1.02, -1.93); parts.push(colored(tl, C.taillight));
  }
  const fb = box(1.52, 0.14, 0.14); fb.translate(0, 0.46, 1.86); parts.push(colored(fb, C.trim));
  const rb2 = box(1.52, 0.14, 0.14); rb2.translate(0, 0.46, -1.86); parts.push(colored(rb2, C.trim));
  // hood + tailgate shut-lines (thin dark seams for realism)
  const hoodSeam = box(1.20, 0.008, 0.02); hoodSeam.translate(0, 1.032, 0.62); parts.push(colored(hoodSeam, C.trim));
  const hatchSeam = box(1.10, 0.008, 0.02); hatchSeam.translate(0, 1.10, -1.62); parts.push(colored(hatchSeam, C.trim));
  return parts;
}

// ── zone_wheels: 4 × tire + rim + spokes + hub (185/55R15 ⇒ r≈0.285) ──
function buildWheels() {
  const parts = [];
  for (const sx of [-1, 1]) for (const sz of [1, -1]) {
    const x = sx * 0.70, z = sz * 1.22;
    const tire = new THREE.TorusGeometry(0.21, 0.078, 14, 28);
    tire.rotateY(Math.PI / 2);
    tire.translate(x, 0.285, z);
    parts.push(colored(tire, C.tire));
    const rim = cyl(0.155, 0.155, 0.17, 24);
    rim.rotateZ(Math.PI / 2);
    rim.translate(x, 0.285, z);
    parts.push(colored(rim, C.rim));
    for (let i = 0; i < 5; i++) {
      const spoke = box(0.17, 0.028, 0.045);
      spoke.applyMatrix4(M.mul(M.t(x, 0.285, z), M.r(0, 0, 0), M.mul(M.r(0, 0, 0), M.s(1, 1, 1))));
      // orient spokes radially in the wheel plane (YZ): rotate around x
      const m = M.mul(M.t(x, 0.285, z), M.r((i * 2 * Math.PI) / 5, 0, 0), M.t(0, 0.075, 0));
      spoke.applyMatrix4(m);
      parts.push(colored(spoke, C.rim));
    }
    const hub = cyl(0.045, 0.045, 0.18, 12);
    hub.rotateZ(Math.PI / 2);
    hub.translate(x, 0.285, z);
    parts.push(colored(hub, C.engineDark));
  }
  return parts;
}

// ── zone_brakes: front discs ⌀266 + orange calipers, rear drums ──
function buildBrakes() {
  const parts = [];
  for (const sx of [-1, 1]) {
    const disc = cyl(0.133, 0.133, 0.022, 32);
    disc.rotateZ(Math.PI / 2);
    disc.translate(sx * 0.60, 0.285, 1.22);
    parts.push(colored(disc, C.steel));
    const hat = cyl(0.07, 0.07, 0.05, 20);
    hat.rotateZ(Math.PI / 2);
    hat.translate(sx * 0.60, 0.285, 1.22);
    parts.push(colored(hat, C.engineDark));
    const cal = box(0.06, 0.10, 0.13);
    cal.translate(sx * 0.60, 0.40, 1.32);
    parts.push(colored(cal, C.caliper));
  }
  for (const sx of [-1, 1]) {
    const drum = cyl(0.105, 0.105, 0.10, 24);
    drum.rotateZ(Math.PI / 2);
    drum.translate(sx * 0.64, 0.285, -1.22);
    parts.push(colored(drum, C.engineDark));
  }
  return parts;
}

// ── zone_suspension: front struts + arms, rear beam ──
function buildSuspension() {
  const parts = [];
  for (const sx of [-1, 1]) {
    const strut = cyl(0.032, 0.032, 0.46, 14);
    strut.applyMatrix4(M.mul(M.t(sx * 0.58, 0.52, 1.16), M.r(0.12, 0, 0)));
    parts.push(colored(strut, C.engine));
    const spring = new THREE.TorusGeometry(0.055, 0.012, 8, 20, Math.PI * 1.6);
    spring.rotateY(Math.PI / 2);
    spring.translate(sx * 0.58, 0.66, 1.13);
    parts.push(colored(spring, C.engineDark));
    const arm = box(0.05, 0.035, 0.34);
    arm.translate(sx * 0.45, 0.24, 1.24);
    parts.push(colored(arm, C.engineDark));
  }
  const beam = cyl(0.04, 0.04, 1.10, 16);
  beam.rotateX(Math.PI / 2);
  beam.translate(0, 0.30, -1.22);
  parts.push(colored(beam, C.engine));
  return parts;
}

// ── zone_engine: TU-family-looking block, valve cover, pulley, airbox ──
function buildEngine() {
  const parts = [];
  const block = box(0.52, 0.38, 0.46); block.translate(0.08, 0.52, 1.30); parts.push(colored(block, C.engine));
  const head = box(0.50, 0.10, 0.44); head.translate(0.08, 0.76, 1.30); parts.push(colored(head, C.engineDark));
  const cover = box(0.42, 0.08, 0.38); cover.translate(0.08, 0.85, 1.30); parts.push(colored(cover, C.engineDark));
  const pulley = cyl(0.09, 0.09, 0.045, 20); pulley.rotateX(Math.PI / 2); pulley.translate(0.08, 0.52, 1.56); parts.push(colored(pulley, C.steel));
  const belt = new THREE.TorusGeometry(0.115, 0.012, 8, 24); belt.translate(0.08, 0.52, 1.585); parts.push(colored(belt, C.tire));
  const airbox = box(0.24, 0.20, 0.30); airbox.translate(-0.38, 0.72, 1.42); parts.push(colored(airbox, C.engineDark));
  const intake = cyl(0.035, 0.035, 0.34, 12); intake.rotateZ(Math.PI / 2); intake.translate(-0.12, 0.70, 1.42); parts.push(colored(intake, C.engineDark));
  const exhaust = cyl(0.04, 0.04, 0.30, 12); exhaust.rotateX(Math.PI / 2); exhaust.translate(0.30, 0.42, 1.05); parts.push(colored(exhaust, C.engineDark));
  return parts;
}

// ── part_radiator_main: 600×380 core + fins + plastic tanks ──
function buildRadiator() {
  const parts = [];
  const core = box(0.60, 0.38, 0.028); core.translate(0, 0.62, 1.66); parts.push(colored(core, C.radiator));
  for (let i = 0; i < 9; i++) {
    const fin = box(0.585, 0.012, 0.032);
    fin.translate(0, 0.445 + i * 0.0435, 1.661);
    parts.push(colored(fin, C.radiatorFin));
  }
  for (const ty of [0.445, 0.795]) {
    const tank = box(0.645, 0.075, 0.045);
    tank.translate(0, ty, 1.66);
    parts.push(colored(tank, C.tank));
  }
  return parts;
}

// ── zone_cooling: fan + shroud + hoses (radiator PART is separate) ──
function buildCooling() {
  const parts = [];
  const shroud = box(0.52, 0.32, 0.03); shroud.translate(0, 0.62, 1.585); parts.push(colored(shroud, C.fan));
  const fanRing = new THREE.TorusGeometry(0.135, 0.014, 8, 24); fanRing.translate(0.12, 0.62, 1.565); parts.push(colored(fanRing, C.fan));
  for (let i = 0; i < 6; i++) {
    const blade = box(0.045, 0.11, 0.012);
    blade.applyMatrix4(M.mul(M.t(0.12, 0.62, 1.565), M.r(i * Math.PI / 3, 0, 0), M.t(0, 0.065, 0)));
    parts.push(colored(blade, C.fan));
  }
  const topHose = new THREE.CapsuleGeometry(0.026, 0.34, 6, 12);
  topHose.applyMatrix4(M.mul(M.t(0.28, 0.86, 1.52), M.r(0, 0, Math.PI / 2.6)));
  parts.push(colored(topHose, C.hose));
  const lowHose = new THREE.CapsuleGeometry(0.026, 0.30, 6, 12);
  lowHose.applyMatrix4(M.mul(M.t(0.26, 0.44, 1.50), M.r(0, 0, Math.PI / 2.2)));
  parts.push(colored(lowHose, C.hose));
  return parts;
}

// ── part_battery_main: 55Ah 242×175×190 + terminals ──
function buildBattery() {
  const parts = [];
  const body = box(0.242, 0.175, 0.190); body.translate(-0.45, 0.71, 1.16); parts.push(colored(body, C.battery));
  const top = box(0.242, 0.02, 0.190); top.translate(-0.45, 0.808, 1.16); parts.push(colored(top, C.batteryTop));
  const tPos = cyl(0.017, 0.017, 0.035, 12); tPos.translate(-0.53, 0.835, 1.10); parts.push(colored(tPos, C.terminalPos));
  const tNeg = cyl(0.017, 0.017, 0.035, 12); tNeg.translate(-0.53, 0.835, 1.22); parts.push(colored(tNeg, C.terminalNeg));
  const clamp = box(0.26, 0.015, 0.05); clamp.translate(-0.45, 0.83, 1.16); parts.push(colored(clamp, C.steel));
  return parts;
}

// ── zone_electrical: fuse box + cable runs + alternator ──
function buildElectrical() {
  const parts = [];
  const fuse = box(0.16, 0.09, 0.13); fuse.translate(-0.62, 0.78, 1.38); parts.push(colored(fuse, C.engineDark));
  const alt = cyl(0.055, 0.055, 0.10, 16); alt.rotateZ(Math.PI / 2); alt.translate(0.32, 0.60, 1.55); parts.push(colored(alt, C.steel));
  const cable1 = new THREE.CapsuleGeometry(0.011, 0.42, 4, 8);
  cable1.applyMatrix4(M.mul(M.t(-0.50, 0.84, 1.28), M.r(0, Math.PI / 2, Math.PI / 2)));
  parts.push(colored(cable1, C.terminalPos));
  const cable2 = new THREE.CapsuleGeometry(0.009, 0.50, 4, 8);
  cable2.applyMatrix4(M.mul(M.t(0.10, 0.90, 1.50), M.r(Math.PI / 2.4, 0, 0)));
  parts.push(colored(cable2, C.hose));
  return parts;
}

// ── part_oil_filter_main: ⌀76×90 canister + hex base ──
function buildOilFilter() {
  const parts = [];
  const can = cyl(0.038, 0.038, 0.09, 20); can.translate(0.40, 0.50, 1.50); parts.push(colored(can, C.filterOrange));
  const base = cyl(0.030, 0.030, 0.03, 6); base.translate(0.40, 0.44, 1.50); parts.push(colored(base, C.steel));
  return parts;
}

// ── part_brake_pad_front_main: pad pair inside the +x front caliper ──
function buildBrakePads() {
  const parts = [];
  const backing = box(0.02, 0.075, 0.11); backing.translate(0.645, 0.285, 1.245); parts.push(colored(backing, C.pad));
  const friction = box(0.016, 0.065, 0.10); friction.translate(0.628, 0.285, 1.245); parts.push(colored(friction, C.pad));
  return parts;
}

// ── zone_interior: dash, wheel, seats, bench ──
function buildInterior() {
  const parts = [];
  const dash = box(1.42, 0.20, 0.34); dash.translate(0, 1.00, 0.42); parts.push(colored(dash, C.dash));
  const wheel = new THREE.TorusGeometry(0.105, 0.016, 8, 22);
  wheel.applyMatrix4(M.mul(M.t(-0.35, 0.98, 0.28), M.r(1.05, 0, 0)));
  parts.push(colored(wheel, C.engineDark));
  for (const sx of [-1, 1]) {
    const squab = box(0.46, 0.12, 0.46); squab.translate(sx * 0.36, 0.72, -0.12); parts.push(colored(squab, C.seat));
    const back = box(0.46, 0.52, 0.10); back.applyMatrix4(M.mul(M.t(sx * 0.36, 0.98, -0.38), M.r(-0.15, 0, 0)));
    parts.push(colored(back, C.seat));
    const headrest = box(0.22, 0.10, 0.08); headrest.translate(sx * 0.36, 1.30, -0.43); parts.push(colored(headrest, C.seat));
  }
  const bench = box(1.15, 0.22, 0.50); bench.translate(0, 0.74, -0.92); parts.push(colored(bench, C.seat));
  const benchBack = box(1.15, 0.50, 0.10); benchBack.translate(0, 1.02, -1.18); parts.push(colored(benchBack, C.seat));
  return parts;
}

// ── part_floor_mat_main: driver + passenger mats in the footwells ──
function buildFloorMats() {
  const parts = [];
  for (const sx of [-1, 1]) {
    const mat = box(0.44, 0.018, 0.34); mat.translate(sx * 0.36, 0.455, 0.10); parts.push(colored(mat, C.mat));
    const edge = box(0.44, 0.026, 0.03); edge.translate(sx * 0.36, 0.455, -0.06); parts.push(colored(edge, C.trim));
  }
  return parts;
}

// ── assemble the 13 contract meshes ──
const meshes = {
  zone_body: buildBody(),
  zone_wheels: buildWheels(),
  zone_brakes: buildBrakes(),
  zone_suspension: buildSuspension(),
  zone_engine: buildEngine(),
  zone_cooling: buildCooling(),
  zone_electrical: buildElectrical(),
  zone_interior: buildInterior(),
  part_radiator_main: buildRadiator(),
  part_battery_main: buildBattery(),
  part_oil_filter_main: buildOilFilter(),
  part_brake_pad_front_main: buildBrakePads(),
  part_floor_mat_main: buildFloorMats(),
};

// ── GLB serializer (glTF 2.0 binary, POSITION+NORMAL+COLOR_0+indices) ──
function buildGlb(namedGeos) {
  const binChunks = [];
  const bufferViews = [];
  const accessors = [];
  const nodes = [];
  const gltfMeshes = [];
  let offset = 0;

  const pushView = (typedArr, target) => {
    const bytes = new Uint8Array(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength);
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { binChunks.push(new Uint8Array(pad)); offset += pad; }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    binChunks.push(bytes);
    offset += bytes.byteLength;
    return bufferViews.length - 1;
  };

  const names = Object.keys(namedGeos);
  names.forEach((name, meshIndex) => {
    const merged = mergeGeometries(namedGeos[name], false);
    merged.computeBoundingSphere();
    const pos = merged.attributes.position.array;
    const nor = merged.attributes.normal.array;
    const col = merged.attributes.color.array;
    // mergeGeometries of toNonIndexed() sources is non-indexed → sequential index
    const idx = merged.index
      ? merged.index.array
      : new Uint32Array(merged.attributes.position.count).map((_, i) => i);
    const posView = pushView(new Float32Array(pos), 34962);
    const norView = pushView(new Float32Array(nor), 34962);
    const colView = pushView(new Float32Array(col), 34962);
    const idxView = pushView(new Uint32Array(idx), 34963);
    accessors.push({ bufferView: posView, componentType: 5126, count: pos.length / 3, type: "VEC3", min: [...merged.boundingSphere.center.toArray().map((v, i) => v - merged.boundingSphere.radius)], max: [...merged.boundingSphere.center.toArray().map((v, i) => v + merged.boundingSphere.radius)] });
    accessors.push({ bufferView: norView, componentType: 5126, count: nor.length / 3, type: "VEC3" });
    accessors.push({ bufferView: colView, componentType: 5126, count: col.length / 3, type: "VEC3" });
    accessors.push({ bufferView: idxView, componentType: 5125, count: idx.length, type: "SCALAR" });
    const ai = accessors.length - 4;
    gltfMeshes.push({ name, primitives: [{ attributes: { POSITION: ai, NORMAL: ai + 1, COLOR_0: ai + 2 }, indices: ai + 3, material: 0 }] });
    nodes.push({ name, mesh: meshIndex });
  });

  const gltf = {
    asset: { version: "2.0", generator: "POOM build-206-model.mjs (in-repo procedural)" },
    scene: 0,
    scenes: [{ name: "peugeot-206", nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials: [{
      name: "poom-vertex-color",
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.15, roughnessFactor: 0.55 },
    }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  };

  const bin = (() => { const total = binChunks.reduce((a, c) => a + c.length, 0); const out = new Uint8Array(total); let o = 0; for (const c of binChunks) { out.set(c, o); o += c.length; } return out; })();
  const binPad = (4 - (bin.length % 4)) % 4;
  const binPadded = binPad ? new Uint8Array(bin.length + binPad) : bin;
  if (binPad) { binPadded.set(bin, 0); }
  gltf.buffers[0].byteLength = binPadded.length;

  let jsonStr = JSON.stringify(gltf);
  const jsonPad = (4 - (Buffer.byteLength(jsonStr) % 4)) % 4;
  jsonStr = jsonStr + " ".repeat(jsonPad);
  const jsonBuf = Buffer.from(jsonStr, "utf8");

  const total = 12 + 8 + jsonBuf.length + 8 + binPadded.length;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(0x46546C67, 0);      // "glTF"
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(jsonBuf.length, 12);
  glb.writeUInt32LE(0x4E4F534A, 16);     // "JSON"
  jsonBuf.copy(glb, 20);
  const binHeaderAt = 20 + jsonBuf.length;
  glb.writeUInt32LE(binPadded.length, binHeaderAt);
  glb.writeUInt32LE(0x004E4942, binHeaderAt + 4); // "BIN\0"
  binPadded.forEach ? null : null;
  Buffer.from(binPadded).copy(glb, binHeaderAt + 8);
  return glb;
}

mkdirSync(dirname(OUT), { recursive: true });
const glb = buildGlb(meshes);
writeFileSync(OUT, glb);

// summary
const stats = Object.entries(meshes).map(([n, list]) => {
  const tri = list.reduce((a, g) => a + g.attributes.position.count / 3, 0);
  return `${n}: ${list.length} shapes, ${Math.round(tri)} tris`;
});
console.log(`Wrote ${OUT} (${(glb.length / 1024).toFixed(0)} KB)`);
console.log(stats.join("\n"));
