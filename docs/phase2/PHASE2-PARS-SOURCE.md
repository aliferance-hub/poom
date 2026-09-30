# P2-Pars — Peugeot Pars (پژو پارس) vehicle page: source, pipeline & provenance

Date: 2026-09-30 · Owner request: «یه ماشین اضافه کن به نام پژو پارس» · Status: **shipped as PLACEHOLDER (by design)**

## 1. What was built

A second vehicle, **پژو پارس** (`Peugeot` / `Pars`, SEDAN), with the same 8-zone
catalog structure as the 206, its own vehicle page
(`src/app/vehicles/peugeot/pars/page.tsx` + `zone/[key]`), a nav link
(«پژو پارس») and a homepage CTA. The 3D viewer renders the shipped GLB through
the same contract pipeline as the 206 (`resolveContract` → `AssetContractV2`).

## 2. Source package and its rights status (the important part)

- Owner-supplied download from **archfly.ir**, item
  «مدل سه بعدی رایگان پژو پارس» (published 2020-10-05; formats 3ds max / FBX /
  OBJ / VRAY). Download filename `(archfly.ir)_car.001_opada.rar` matches the
  delivered package byte-for-byte in naming.
- **No license and no creator are stated anywhere on the source page or in the
  package.** Therefore, per the P2-J truthfulness rules:
  - `Asset.kind = SYNTHETIC`, version state = `PLACEHOLDER` (terminal —
    promotion is impossible while rights are UNKNOWN);
  - provenance records `licenseType: UNSPECIFIED`, creator `null`,
    commercial/redistribution/modification `UNKNOWN`;
  - the validator verdict on the shipped artifact is intentionally
    `FAIL (rights only)`: `LICENSE_MISSING`, `RIGHT_UNKNOWN ×3`,
    `CREATOR_UNKNOWN (warning)`. Structure / security / selfContained all PASS.
- The artifact lives on the tracked static path
  `public/uploads/assets/peugeot-pars-main-v1/v1/peugeot-pars-placeholder.glb`
  and the viewer shows «موجود، ولی نمونهٔ جایگزین (مدل واقعی ثبت نشده است)».

## 3. Conversion chain (what worked, what did not)

| Step | Result |
| --- | --- |
| FBX → GLB (FBX2glTF 0.9.7) | **Unusable**: every node bbox clamped to ±32767 on this file (readback bug); V-Ray textures unresolvable (`Map #29`…) |
| OBJ → GLB (`obj2gltf`) | **Good**: 68 named nodes, 537,256 triangles, bounds 179.5 × 79.2 × 65.8 (units), single untextured material |
| Node/mesh names | Fully preserved, semantically Persian-romanized: `Body`, `chair`, `farmon`, `tire1-4`, `ring1-4`, `ayene*`, `cleaner*`, `exoz`, `kamarband`, `fanar`, `plak*`, `Glass`, `front`, `pars_logo`, `peugeot`, `logo*`… |
| Material evidence | The FBX strings give the original material→node wiring (HDM_06_001_50 = body paint, HDM_06_001_30 = glass, `cheragh jolo*` = headlights, `backlight*` = tail lights, `test2` (#1b1b1b) = interior/trim, `tyre` = tyres, `ring` = wheels). It was used to re-create per-node materials on the OBJ GLB, which obj2gltf had collapsed into one material |

## 4. Final artifact recipe (`.freebuff/pars-glb/bind-and-optimize.mjs`)

1. **Vertex bake (orientation + scale).** The source OBJ is X-longitudinal
   (front = +X: `plak_f`/`front`/`ligh_f_g` centered at x ≈ +77…82, `plak` /
   `backlight` at x ≈ −92…−94; axle-centre yaw ≈ −0.6°) and Z-up. The viewer is
   Y-up with front = +Z, and `RealModel` renders mesh clones **without ancestor
   transforms**, so the transform was baked into the POSITION arrays:
   `(x, y, z) → (y·0.025, z·0.025, −x·0.025)`.
   Result ≈ **1.92–2.06 m wide × 1.42–1.65 m tall × 4.48–4.54 m long** —
   matches the 206 viewer footprint (2.97 × 2.37 × 4.92).
2. **11 materials created per the FBX wiring** (paint silver-gray
   `[0.62,0.635,0.66]` from the source renders' dominant buckets, blended
   glass, lamp lenses, interior #1b1b1b-family, tyre rubber, wheel rings,
   plates, chrome badges, dark trim). Coverage of all 68 nodes; nothing left on
   the collapsed default.
3. **3 real textures bound** (the only ones in the package):
   `cheragh.jpg` → headlamp lens, `backlight.jpg` → tail lights,
   `HDM_03_tyre_sidewall.png` → tyres (alpha decal used opaque). `l1.jpg`
   (amber) intentionally unbound: its FBX target (`side2`/`orang`) is rendered
   as body paint in v1. `light.jpg` / `306_232.png` had no node target in the
   wiring table.
4. **Contract node `zone_body`** added (viewer-space box 1.75 × 0.55 × 4.20 @
   y 0.95) because `RealModel` only renders meshes matched by contract
   zones/parts — without it the GLB would never appear. A `MeshMapping`
   (`zone_body` → body zone, fingerprint measured from the shipped bytes) is
   created idempotently by `setup-pars.mts` so the mapping health is
   `MAPPING_VALID`.
5. **Optimization**: prune → dedup → weld → quantize.
   `meshopt()` was tried and **deliberately dropped**: in this gltf-transform
   version it emits a 2-buffer GLB (compressed + fallback buffer) which
   violates the project validator's single-buffer invariant and breaks
   single-buffer loaders. Result: **10,686,888 bytes**, sha256
   `5f87030c4e66602f…`, one buffer, no extensions required.

## 5. Verification evidence

- `auditAsset` (project validator, `raw-ingestion` profile) on the shipped
  bytes: structure PASS, security PASS, selfContained PASS, 69 inventory
  entries, 0 unnamed/duplicate; FAIL only on rights (as designed).
- Standalone render matrix (three r186, same loader stack as the app, 12 yaw
  angles × capture): model loads, footprint 2.06 × 1.65 × 4.54, gray body /
  dark glass+tyres, no orientation or scale anomaly. (In-app pixel readback is
  not possible without `preserveDrawingBuffer`; the availability block
  `data-vehicle3d="PLACEHOLDER"` + GLB 200 + contract resolution were verified
  in the real app.)
- Local golden DB: vehicle `cmunrs3go0000txhsazmlo3ul`, 8 zones, asset
  `peugeot-pars-main-v1`, PLACEHOLDER v1, mapping `zone_body`;
  `resolveContract` → `fileUrl /uploads/assets/.../peugeot-pars-placeholder.glb`,
  `vehicle3d: PLACEHOLDER`, `zoneDisplay: AVAILABLE`.
- Pages 200 locally: `/vehicles/peugeot/pars`,
  `/vehicles/peugeot/pars/zone/body`, the GLB, and the 206 pages (regression).
- Full suite: 19 files / 272 tests green; scoped `tsc` clean
  (`tsconfig.scoped.json`; full-project tsc/eslint OOM in this 8 GB box —
  `next build` passed, which typechecks the app).

## 6. Prod notes

- Data script: run `npx tsx .freebuff/pars-glb/setup-pars.mts` with
  `DATABASE_URL` pointed at the prod pooler (the script is idempotent and
  writes vehicle + zones + asset + PLACEHOLDER version + `zone_body` mapping;
  non-local DBs require the operator's explicit intent, mirroring the P2-J CLI
  convention). The GLB itself ships from the tracked static path like 206 v2 —
  no storage upload needed.
- The Pars page can never show "مدل واقعی" until a rights-documented Pars model
  is ingested through `scripts/p2j-asset-pipeline.mts` and promoted through the
  gates. This is the intended behavior, not a bug.
