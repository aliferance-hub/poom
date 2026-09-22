# PHASE2-3D — P2-A: Asset Registry + Mapping Studio + Viewer UX

Date: 2026-09-14 · Status: **implemented and verified** (see evidence below)

## What was built

### Asset Registry v2 (`src/lib/asset-registry.ts`)

Version lifecycle with license metadata, exactly as specified:

```
Upload → DRAFT → PROCESSING → validate → READY → ACTIVE (exactly one) → ARCHIVED
                                 ↘ REJECTED (bad magic bytes / empty / bad mime / commercial-without-license)
Rollback = activate an older ARCHIVED/READY version (data-only, no code change)
```

- `AssetVersion` carries: `version`, `status` (DRAFT/PROCESSING/READY/ACTIVE/ARCHIVED/REJECTED), `filePath/fileUrl/previewUrl/fileSize/mimeType/checksumSha256`, license block (`licenseType/licenseUrl/sourceUrl/creator/attributionText/commercialUse`), `activatedAt`.
- Single-active invariant enforced transactionally (previous ACTIVE archived inside the same `$transaction`).
- Uploads validated by **glTF-binary magic bytes** (`glTF` header), non-empty size, mime, and the rule *commercial use ⇒ licenseType required*.
- **EMPTY_MAPPING_SET guard**: a version with zero mesh mappings cannot go ACTIVE — it would blank the storefront viewer.

### Mesh mapping (unified, version-scoped)

`MeshMapping { versionId, meshName, kind: zone|assembly|part, zoneId|assemblyId|partId, label, hotspotJson, cameraPositionJson, cameraTargetJson, explodedOffsetJson, sortOrder }`

- `@@unique([versionId, meshName])` — one row per mesh per version.
- GLB version A ⇒ mapping set A; GLB version B ⇒ mapping set B. Catalog/commerce records untouched by 3D changes.
- The denormalized `MeshMapping.assetId` FK was **removed** (migration `20260914_p2a_drop_meshmapping_asset_fk`): `versionId` is the single source of truth; UI pages traverse `asset.versions[].meshMappings`.

### Upload API (`src/app/api/admin/assets/[assetId]/upload/route.ts`)

Multipart POST → magic-byte check → SHA-256 checksum → DRAFT version row. Rejects non-GLB with `{error:"NOT_A_GLB"}`. Demo trust gate applies.

### Mapping Studio (`/admin/assets/[assetId]`)

- Version list with per-version mapping counts + status/license badges
- GLB upload form (license metadata + commercial-use toggle)
- Publish / Rollback buttons with typed error surfacing (Persian `خطا: …` messages)
- 3D scene (R3F) with the demo placeholder car; click a mesh → inspector
- Inspector: kind tabs (zone/assembly/part), target select, Persian hotspot label, **ذخیره نگاشت**, **ثبت دوربین فعلی** (camera preset capture from the live orbit camera), **انفجار +Y** (exploded offset), **حذف نگاشت**
- Canvas has an accessible `role="img"` + Persian `aria-label`
- No React changes needed to remap a mesh → part

### Viewer upgrades (`src/components/viewer/car-scene.tsx`)

All rendering is driven by `resolveContract(vehicleId)` (from `MeshMapping` rows of the ACTIVE version) — no mesh knowledge hard-coded in the component logic (only the placeholder-shape table, to be replaced by GLB loading):

- Contract-derived meshes; click part-mesh → `/parts/[slug]`, click zone-mesh → zone select
- **Hotspot markers** from `hotspotJson` (sphere markers, depthTest off, hover label)
- **Section isolation** (نمایش ایزوله): non-active-zone meshes dimmed to opacity 0.12
- **Exploded view** (نمای انفجاری): per-mesh `explodedOffsetJson` with smooth lerp
- **Camera presets** per zone (`cameraPositionJson/cameraTargetJson`) with tweened CameraRig
- **Deep link**: `?zone=cooling` syncs via `history.replaceState`
- **Reduced motion**: `prefers-reduced-motion` snaps the camera instead of tweening
- Reset / fullscreen controls; zone panel with breadcrumb link; loading bar
- 2D/WebGL fallback (`Canvas` `fallback` + `webglcontextlost` handler)

## Verification evidence (all re-run after fixes)

| Check | Command / method | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | 0 errors |
| Tests | `vitest run` | **25/25 passed** (3 files) — incl. EMPTY_MAPPING_SET guard, DRAFT can't jump to ACTIVE, magic-byte rejection, commercial-without-license rejection, full lifecycle + rollback + contract resolver swap, parallel first-touch cart race, parallel same-offer add merge |
| Build | `npm run build` (dev server stopped first) | ✓ 21 routes, 103 kB shared First Load JS |
| Upload happy path | live POST with a minimal valid GLB | v2 DRAFT created, checksum recorded |
| Upload rejection | live POST with fake `.glb` | `{error:"NOT_A_GLB"}` |
| Publish | Studio button on v2 | v1 ARCHIVED → v2 ACTIVE (single active) |
| Empty-contract behavior | storefront with v2 active | scene renders empty, **no crash** (data-driven) |
| Rollback | Studio button back to v1 | v1 ACTIVE again; storefront car + hotspots restored (screenshot) |
| EMPTY_MAPPING_SET guard live | publish attempt on mapping-less v2 | blocked with Persian error message; v2 stayed READY |
| Studio write path | click `zone_body` → save → PostgreSQL | `MeshMapping` row updated (`updatedAt` fresh) |
| Console | `preview_logs` | no app errors |
| Regression | home / vehicle / part / cart / checkout / search / admin / seller | all HTTP 200 |

## Bugs found & fixed during P2-A verification

1. **Studio showed "0 نگاشت"** — the page traversed `asset.mappings`, but mappings only carried `versionId`; the denormalized `assetId` was NULL. Fixed by removing the denormalized FK entirely (single source of truth = `versionId`) and traversing `asset.versions[].meshMappings` in both admin pages. Migration: `20260914_p2a_drop_meshmapping_asset_fk`.
2. **Publishing a mapping-less version would blind the storefront** (verified live: empty scene, no crash). Fixed with the `EMPTY_MAPPING_SET` guard in `activateVersion`/`rollbackToVersion` + typed error results in the server actions (production Next.js masks thrown action errors) + Persian error display in the Studio.
3. **`/cart` 500 — cart creation race** (page + `/api/cart` both fired on first paint): `prisma.cart.upsert` fell back to read-then-write and the second insert violated `unique(sessionId)`. Fixed with create-first + `P2002` catch-and-retry in `getOrCreateCart`, plus the same pattern for parallel same-offer `cartItem` adds (merge into the winning line). Two regression tests added.
4. **`processVersionAction` could throw raw** (`BAD_STATE:ARCHIVED`) and crash the transition — now returns `{ok:false, error|problems}` handled in the UI.
5. Studio canvas had no accessible name — added `role="img"` + Persian `aria-label` (also makes it reachable in automation/a11y trees).

## Known P2-A limitations

- The Studio and storefront render **builtin placeholder geometry** (name-mirroring demo boxes). A real uploaded GLB is stored+validated+versioned but not yet rendered — that swap lands with P2-H (first licensed 206 GLB) using the same contract.
- Mapping-studio camera capture reads the live orbit camera; no saved-preset library UI beyond per-zone rows yet.
- No analytics events on 3D interactions yet (P2-F).
