# P2-F — Asset Report (F1/F2)

## Current state of the 206 asset

| Item | Value | Classification |
|---|---|---|
| Asset | `peugeot-206-main-v1` | SYNTHETIC (in-repo placeholder geometry) |
| Active version | v1, `builtin:placeholder-206`, `fileUrl = null` | SYNTHETIC |
| License of placeholder | `IN_REPO_DEMO`, in-repo, no external claims | honest |
| Zone mappings | 8 (`zone_front`, `zone_engine`, `zone_cooling`, `zone_brakes`, `zone_suspension`, `zone_body`, `zone_interior`, `zone_wheels`) each with camera preset | SYNTHETIC, stable identifiers |
| Part mappings | 5 (`part_radiator_main` → **real** `radiator-assembly`, `part_brake_disc` → **real** `front-brake-disc`, `part_brake_pad` → **real** `front-brake-pad`, + 2 demo) | MIXED, data-driven |

**No real licensed GLB exists in the repository.** Per the F1 legal rule, none was downloaded or fabricated.

## What WAS built and verified (the integration pipeline)

1. **Provenance-complete versioning** — `AssetVersion` now records `creator`, `licenseType/Url`, `sourceUrl`, `attributionText`, `commercialUse`, `acquiredAt`, `modifications`, `intendedUsage`, `checksumSha256`.
2. **Validation gate** — `validateVersion()` REJECTS any uploaded (non-`builtin:`) version that lacks license type, creator, acquisition date, or intended usage. The in-repo placeholder is exempt (makes no external claims). Covered by `tests/asset-registry.test.ts`.
3. **Upload flow** — `/api/admin/assets/[assetId]/upload` accepts the full provenance set as form fields (400 on bad input), persists the file under `public/uploads/assets/<assetId>/`, exposes provenance completeness in its response.
4. **Viewer integration** — `car-scene.tsx` lazily loads the active version's real GLB **by mesh name** (`fileUrl` present + not `builtin:`); missing meshes fall back to contract placeholders; any loader failure trips an error boundary that degrades to pure-placeholder mode. WebGL-unavailable environments already degrade to the 2D zone list (verified live in preview).
5. **Mapping layer preserved** — commerce still resolves Mesh → `MeshMapping` → Part; mesh names never leak into offers/pricing.

## Exact requirements for the first REAL asset (acceptance for a future drop-in)

A real Peugeot 206 GLB may be activated only with ALL of:

- [ ] `licenseType` — an actual license identifier (e.g. `CC-BY-4.0`, `PURCHASED`, `OWNERSHIP`) — never `UNSPECIFIED`/`UNKNOWN`/`TBD`
- [ ] `creator` — the legal creator/provider
- [ ] `licenseUrl` or written permission reference
- [ ] `acquiredAt` — acquisition/production date
- [ ] `modifications` — what was altered after acquisition (`none` if untouched)
- [ ] `intendedUsage` — declared scope (e.g. `product viewer`)
- [ ] `commercialUse` flag consistent with the license
- [ ] `checksumSha256` recorded by the upload flow
- [ ] stable mesh names covering the 8 zone identifiers (or a vendor→semantic mesh mapping added in the Mapping Studio)
- [ ] file size/compression within the F11 perf budget (Draco/Meshopt preferred if > ~15 MB)

Drop-in procedure (no commerce changes): Mapping Studio → upload version with provenance → validate → map vendor mesh names to the 8 zones → activate. Rollback re-activates the previous version atomically.
