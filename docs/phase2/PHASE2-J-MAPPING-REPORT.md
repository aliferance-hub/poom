# PHASE 2-J — Zone / Part 3D Mapping Report

> Scope: J10/J27/§25 of P2-J — how a zone or part is attached to 3D geometry, how
> that attachment is proven, what it is allowed to claim to a customer, and the
> measured state of the mappings today.
> Companion documents: `PHASE2-J-ASSET-SOURCE-REPORT.md` (rights/provenance),
> `PHASE2-J-ASSET-VALIDATION.md` (audit layer and gates).

## 1. Four independent facts (never collapsed into one)

The system keeps these apart, on purpose, everywhere — DB, studio UI, customer UI:

    CATALOG PART EXISTS        Part row in the catalog (55 parts locally)
    PART-RELEVANT GEOMETRY     a node with that name exists in a REAL audited GLB
    MAPPING EXISTS             a MeshMapping row named after that node
    MAPPING IS TRUSTED         health = MAPPING_VALID against the CURRENT inventory

Any statement to a customer uses the fourth fact, never the first three. Today
facts 1 and 3 are true for a handful of parts; fact 2 is not true for any part (no
real GLB has been ingested), so fact 4 is false for every part — and the UI says so.

## 2. Mapping model

`MeshMapping` (per **asset version**, `@@unique([versionId, meshName])`):

    meshName           the authored node name, e.g. zone_engine / part_radiator_main
    kind               zone | assembly | part
    zoneId | assemblyId | partId   exactly one target for the declared kind
    meshFingerprint    structural fingerprint measured when the mapping was made
    mappingHealth      cached last result (MAPPING_VALID / NEEDS_REVIEW / INVALID)
    healthCheckedAt    when that cache was written
    label, hotspotJson, camera*, explodedOffsetJson, sortOrder, metadataJson

Mappings belong to a version, so mappings cannot leak between artifacts: the
placeholder's mappings are the placeholder's, and a real model starts with its own
(empty) mapping set. The contract resolver only trusts healthy mappings of the
version that actually resolves.

## 3. Creating a mapping (studio rules)

Server actions in `src/app/studio-actions.ts`:

* `assignMeshAction` refuses when the version is `PRODUCTION` (an immutable
  artifact's mappings are part of what was verified), when the node name is not in
  the version inventory (`NODE_NOT_IN_INVENTORY`), and when the inventory entry is
  `DERIVED_UNNAMED` — a positional key such as `node[7]` is not a name and cannot
  be mapped (`NODE_NAME_NOT_AUTHORED`). On success it stores the measured
  fingerprint and then re-checks health.
* `unassignMeshAction`, `updateMappingMetaAction` (label/hotspot/camera/exploded
  offset), and `refreshMappingHealthAction` complete the set.
* Every action writes to `AssetEventLog` (`mapping_assigned`, `mapping_removed`,
  `health_checked`) with actor and detail.

The mapping studio (`src/components/studio/mapping-studio.tsx`) shows the real file
through the admin file route, lists the measured inventory (node path, nameSource,
triangles, vertices, materials, fingerprints), and lets an operator pick an
AUTHORED node for a zone/assembly/part target instead of typing a name from memory.

## 4. Mapping health (drift detection, §27)

`checkMappingHealth()` (in `src/lib/asset-lifecycle.ts`) evaluates one mapping
against the inventory of its version:

| Result | Reason code | Meaning |
| --- | --- | --- |
| `MAPPING_INVALID` | `TARGET_MISSING` | kind is zone/assembly/part but no target id |
| `MAPPING_INVALID` | `CROSS_VEHICLE_TARGET` | target belongs to a different vehicle |
| `MAPPING_INVALID` | `NODE_MISSING` | no matching node in the inventory |
| `MAPPING_INVALID` | `NODE_HAS_NO_MESH` | node exists but carries no mesh |
| `MAPPING_NEEDS_REVIEW` | `NO_INVENTORY_FOR_VERSION` | version has no measured inventory (e.g. `builtin:`) |
| `MAPPING_NEEDS_REVIEW` | `NODE_NAME_NOT_AUTHORED` | match was positional, not authored |
| `MAPPING_NEEDS_REVIEW` | `NODE_HIDDEN` | node is not visible in the scene |
| `MAPPING_NEEDS_REVIEW` | `FINGERPRINT_NOT_RECORDED` | mapping predates fingerprints |
| `MAPPING_NEEDS_REVIEW` | `FINGERPRINT_CHANGED` | the node changed shape since mapping |
| `MAPPING_VALID` | `OK` | authored node, present, visible, fingerprint matches |

Unknown is never upgraded to valid: legacy mappings without a fingerprint are
`NEEDS_REVIEW`, not `VALID`. Health is recomputed live for the admin page and
persisted on assign, on `stageVersion` (staging refuses `MAPPING_INVALID`), on the
explicit refresh action and via the CLI (`health`).

## 5. Measured state today (local golden DB)

Canonical asset `peugeot-206-main-v1` — `kind = SYNTHETIC`, both versions
`PLACEHOLDER`:

| version | artifact | mappings |
| --- | --- | --- |
| v1 | `builtin:placeholder-206` | 8 zone + 5 part |
| v2 | `uploads/assets/peugeot-206-main-v1/v2/peugeot-206-engineering-v1.glb` (1,294,156 B, sha256 `8c5c11e1…`) | 8 zone + 5 part |

* zones: `body`, `brakes`, `cooling`, `electrical`, `engine`, `interior`,
  `suspension`, `wheels` (all cards `zone_*` meshes authored by the synthetic model)
* parts: `part_battery_main` → `battery-55ah`, `part_brake_pad_front_main` →
  `front-brake-pad`, `part_floor_mat_main` → `floor-mat-set-206`,
  `part_oil_filter_main` → `oil-filter`, `part_radiator_main` →
  `radiator-assembly`

All 26 rows have `meshFingerprint = NULL` and `mappingHealth = NULL`: they were
created before fingerprints existed, so every one of them reports
`MAPPING_NEEDS_REVIEW` (`NO_INVENTORY_FOR_VERSION` for v1's `builtin:` artifact,
`FINGERPRINT_NOT_RECORDED` for v2 once its inventory is measured). This is the
correct, honest state: they are demo mappings on a synthetic stand-in and are
treated as untrusted.

## 6. Superseded mappings

When a real version is staged as the new production artifact, the placeholder
versions are **retired**, not deleted: their mappings stay attached to the retired
version's history and can still be inspected, but they stop being resolved because
`resolveContract()` picks PRODUCTION first and falls back to the latest
`PLACEHOLDER` only when nothing has been promoted. A retired version's mappings
are therefore superseded by the promoted version's mappings, with no silent
carry-over: the real GLB must have its own mappings created against its own
measured inventory, and any mapping whose fingerprint no longer matches reports
drift instead of pointing at the wrong node.

## 7. What the customer UI may say

`resolveContract()` builds the viewer contract from the resolved version and
per-mapping health (`health`, `trusted`) plus `describeAvailability()`
(`src/lib/asset-lifecycle.ts`):

* `vehicle3d = REAL` only when `kind = REAL` **and** `state = PRODUCTION`;
  otherwise `PLACEHOLDER` (with a synthetic notice) or `UNAVAILABLE` when no asset
  exists at all.
* `zoneDisplay = AVAILABLE` when at least one zone mapping is not `INVALID`;
  `mappedPartIds` contains only `MAPPING_VALID` part mappings.
* untrusted mappings are returned with their reason so the UI can explain them.

Surfaces:

* `src/components/viewer/car-scene.tsx` — availability block with
  `data-testid="availability"` exposing `data-vehicle3d`, `data-zone-display`,
  `data-part-mapping`, and a Persian line under the part focus:
  «نمایش دقیق این قطعه: موجود | ناموجود — نگاشت آزمایشی روی نمونهٔ جایگزین | ناموجود».
  Attribution text is rendered only when the resolved asset is real production.
* `src/app/parts/[slug]/page.tsx` — `data-testid="part-3d-availability"` with the
  MAPPED / DEMO_ONLY / UNAVAILABLE states; the DEMO_ONLY copy states explicitly
  that what is shown is a test mapping on a stand-in and not the part's real place.
* The admin asset page and the mapping studio show per-version inventory, health
  rows, audit verdicts, optimization deltas and the asset event feed.

Net effect: the synthetic 206 can still be demonstrated (internally and to
customers as an explicitly labelled demo) but no part page may claim a real 3D
location. That claim requires `kind = REAL` **and** `state = PRODUCTION` **and** a
`MAPPING_VALID` mapping.

## 8. What happens when a real file arrives (pipeline order)

    npx -y tsx scripts/p2j-asset-pipeline.mts inbox
    #   → lists files/folders dropped into .freebuff/asset-inbox/

    npx -y tsx scripts/p2j-asset-pipeline.mts ingest --file <glb> --meta <provenance.json>
    #   → creates a REAL asset bound to the canonical 206 vehicle (if absent),
    #     audits before storing, re-derives size/sha, writes a report to
    #     .freebuff/p2j-reports/, row state RAW (or REJECTED, never stored)

    … validate → inventory → optimize → stage → health → verify → status → promote

    #   → 'inventory' prints the AUTHORED mesh names that may be mapped;
    #     'stage' refuses MAPPING_INVALID mappings; 'status' lists every gate;
    #     'promote' refuses unless all 14 gates pass and requires
    #     ALLOW_PROD_PROMOTION=1 for any non-local database.

Mapping the real model (J10) then means one mapping per zone/part target naming an
AUTHORED node from that inventory, verified in the studio, with the fingerprint
stored — and the part pages may only move to MAPPED after promotion.

## 9. Not done (and why)

* **No real 3D mapping exists.** No rights-documented Peugeot 206 file has been
  delivered, so there is no real geometry to map against; J10 cannot be performed
  without inventing names, which this phase forbids.
* Consequently `vehicle3d` is `PLACEHOLDER` everywhere and no part page claims a
  real 3D location. The demo mappings remain labelled as such.
* Zone/part mapping for the *placeholder* model is intentionally left
  `NEEDS_REVIEW` rather than "fixed" by recording fingerprints against a synthetic
  artifact: a fingerprint on a stand-in would still not be evidence about a 206.

## 10. Verification performed

* `tests/asset-registry.test.ts` — mapping health on a fresh version
  (`MAPPING_VALID`), drift after a mapping exists but the fingerprint is cleared
  (`FINGERPRINT_NOT_RECORDED`), mapping integrity as a promotion gate, placeholder
  isolation (no synthetic version can be promoted).
* `tests/p2j-asset-validation.test.ts` — inventory naming (`AUTHORED` vs
  `DERIVED_UNNAMED`), fingerprints, bbox and metrics used by the health rules.
* `tests/p2h-storage-security.test.ts` — artifacts are read back from storage, not
  from a client-supplied path (`/api/admin/assets/[assetId]/file`).
* Local golden DB query results in §5 were read directly from Postgres
  (`MeshMapping` joined to `AssetVersion`, `VehicleZone`, `Part`).
* Full suite: 19 files / 272 tests passing; `tsc --noEmit`, `eslint` clean.
