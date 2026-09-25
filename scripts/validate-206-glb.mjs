// Validates public/models/peugeot-206-engineering-v1.glb the same way the viewer
// will: GLTFLoader parse + sanitized-name matching against the 13 contract meshes.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as THREE from "three";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const buf = readFileSync(join(ROOT, "public", "models", "peugeot-206-engineering-v1.glb"));

const loader = new GLTFLoader();
const gltf = await new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", res, rej));

const sanitize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
const meshes = [];
gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });

const contract = [
  "zone_body", "zone_engine", "zone_cooling", "zone_wheels", "zone_brakes",
  "zone_suspension", "zone_electrical", "zone_interior",
  "part_radiator_main", "part_oil_filter_main", "part_brake_pad_front_main",
  "part_battery_main", "part_floor_mat_main",
];
const found = [], missing = [];
for (const name of contract) {
  const t = sanitize(name);
  const hit = meshes.find((m) => sanitize(m.name) === t);
  (hit ? found : missing).push(name);
}
const totalTris = meshes.reduce((a, m) => a + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
console.log(`meshes in file: ${meshes.length}`);
console.log(`resolved: ${found.length}/13 · missing: ${missing.length ? missing.join(",") : "none"}`);
console.log(`total triangles: ${Math.round(totalTris)}`);
if (missing.length) process.exit(1);
console.log("GLB OK — viewer will resolve every contract mesh from the real model");
