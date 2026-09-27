# PHASE 2-J — Asset Validation Layer (design of record)

> Scope: J2/J3 of P2-J. This document records **how a 3D file becomes a trustable
> asset** in POOM: what is measured, what is refused, what is stored as evidence,
> and which gate has to open before a real Peugeot 206 model may reach customers.
> Nothing here is aspirational: every rule below exists as code and as a test.

## 1. Principle: audit before store, evidence before claim

The pipeline was rebuilt so that **no bytes reach the customer-facing bucket
before they have been parsed, measured and judged**:

1. the file is parsed and audited in memory (`src/lib/asset-validation/`);
2. a failing audit creates a `REJECTED` version row with
   `filePath = "rejected:never-stored"` — the object is **never uploaded**;
3. a passing audit uploads the immutable raw artifact and writes the `RAW` row;
4. if the DB write fails after a successful upload, the object is deleted
   (compensating action) so no orphan object is left in the bucket.

Consequence, stated plainly: an artifact that is invalid, license-restricted or
non-self-contained cannot be delivered by accident, because delivery reads from
the bucket and the bucket only ever holds audited objects.

## 2. Modules

| Module | Responsibility |
| --- | --- |
| `src/lib/asset-validation/glb.ts` | GLB container parse (header, chunks, declared vs actual length). Rejects `.gltf`/ZIP with a precise reason. |
| `…/structure.ts` | glTF structural validation: index bounds, buffer/bufferView/accessor arithmetic, node graph cycles, `min`/`max` sanity, mesh/primitive/material/texture/camera/skin/animation shape, extension policy, hard limits. |
| `…/security.ts` | Untrusted-input checks: external references, suspicious URIs, script markers, executable/archive magic inside the BIN chunk, prototype-pollution keys, accessor-count and inline-data bombs. |
| `…/inventory.ts` | Mesh inventory (hierarchy paths, per-mesh triangle/vertex counts, materials, bbox, structural fingerprint), metrics + GPU estimate, `inventoryHash`. |
| `…/provenance.ts` | Provenance record validation, license allowlist/restricted patterns, tri-state rights, checksum/size/date verification. |
| `…/compare.ts` | Raw-vs-optimized comparison: measured deltas plus quality gates that refuse silent degradation. |
| `…/index.ts` | `auditAsset()` orchestrator, `summarizeAudit()` → `StoredAudit`, `sha256()`, `auditSummaryLine()`. |
| `src/lib/asset-lifecycle.ts` | States, transition rules, mapping health, promotion gates, availability contract. |
| `src/lib/asset-registry.ts` | The only writer of the lifecycle: ingestion, validation, optimization, staging, verification, promotion, rollback, retirement, rejection, events. |

The validation modules are pure: no Prisma, no storage, no network. The same code
runs in tests, in the ingestion CLI and in the server route.

## 3. Verdicts and problem codes

Every finding is `{ code, severity, where?, detail? }` with severity
`error | warning | info`. An `error` anywhere means `verdict: FAIL` and the
artifact is refused. Warnings are recorded and must be justified in the reports;
`info` is descriptive (e.g. `PRIMITIVE_WITHOUT_INDICES` on a fixture triangle).

Dimension verdicts stored with each version: `structure`, `security`,
`selfContained`, `provenance` (only when a record was supplied), and the overall
`verdict`. Selected codes:

* container: `NOT_A_GLB`, `GLB_VERSION_UNSUPPORTED`, `LENGTH_MISMATCH`,
  `CHUNK_TRUNCATED`, `JSON_CHUNK_NOT_FIRST`, `MALFORMED_GLTF_JSON`,
  `MISSING_ASSET_BLOCK`, `TRAILING_BYTES`
* structure: `DANGLING_REFERENCE`, `BUFFER_LENGTH_MISMATCH`,
  `BUFFERVIEW_OUT_OF_RANGE`, `ACCESSOR_OUT_OF_RANGE`, `ACCESSOR_MIN_GT_MAX`,
  `PRIMITIVE_WITHOUT_POSITION`, `MESH_WITHOUT_PRIMITIVES`, `NODE_GRAPH_CYCLE`,
  `EMPTY_SCENE`, `NO_MESHES`, `UNSUPPORTED_REQUIRED_EXTENSION`,
  `NON_FINITE_NUMBER`
* security: `EXTERNAL_REFERENCE` (self-contained contract),
  `SUSPICIOUS_URI`, `SUSPICIOUS_CONTENT_MARKER`, `PROTOTYPE_KEY`,
  `EMBEDDED_EXECUTABLE`, `EMBEDDED_ARCHIVE`, `LIMIT_ACCESSOR_COUNT`,
  `LIMIT_INLINE_DATA`, `LIMIT_IMAGE_BYTES`
* limits: `LIMIT_FILE_BYTES`, `LIMIT_JSON_BYTES`, `LIMIT_TRIANGLES`,
  `LIMIT_NODES`, `LIMIT_MESHES`, `LIMIT_HIERARCHY_DEPTH`, …
* delivery profile: `DELIVERY_FILE_LARGE`, `DELIVERY_TRIANGLES_HIGH`,
  `DELIVERY_TEXTURE_LARGE`, `DELIVERY_DRAW_CALLS_HIGH`
* provenance: `LICENSE_MISSING`, `LICENSE_RESTRICTED`,
  `LICENSE_NOT_IN_ALLOWLIST`, `SOURCE_URL_UNVERIFIABLE`,
  `LICENSE_URL_UNVERIFIABLE`, `ATTRIBUTION_TEXT_REQUIRED`,
  `CHECKSUM_MISMATCH`, `FILE_SIZE_MISMATCH`, `ACQUISITION_DATE_INVALID`,
  `RIGHT_UNKNOWN`, `RIGHT_NOT_GRANTED`, `PLACEHOLDER_URL`

## 4. Limits

Two profiles, deliberately different:

`raw-ingestion` (what we must be able to *look at*):

    failFileBytes        128 MiB      failTriangles        5,000,000
    failJsonBytes         32 MiB      failHierarchyDepth         128
    failNodes             20,000      failDataUriBytes       16 MiB
    failMeshes            20,000      failAnimations             256
    failMaterials          4,000      failTextureDimension      8192
    failImages               512

`production-delivery` = `DELIVERY_BUDGET` (what a customer's browser may have to
download; measured, not guessed):

    maxFileBytes   12 MiB     maxTriangles   600,000     maxTextureDimension  4096

The HTTP upload route caps a request at 4 MiB; larger sources enter through the
CLI (`scripts/p2j-asset-pipeline.mts ingest`) where the raw ceiling applies.

## 5. Provenance and rights

A provenance record must carry: asset identity, source URL, provider, creator,
license id + license URL, download date, original filename, intended usage, and
the tri-state rights (`commercialUse`, `redistributionAllowed`,
`modificationAllowed`). `fileSize` and `sha256` are **not** accepted from the
caller — the registry derives both from the bytes it received, so a record can
never claim a checksum the file does not have, and a mismatch is an error
(`CHECKSUM_MISMATCH`, `FILE_SIZE_MISMATCH`).

License handling:

* allowlist (permissive/open): CC0, public domain, CC-BY 2.0/2.5/3.0/4.0,
  CC-BY-SA 3.0/4.0, MIT, Apache-2.0, BSD-3-Clause → classified as
  `OPEN_PERMISSIVE` / `OPEN_ATTRIBUTION` / `OPEN_SHARE_ALIKE`;
* restricted patterns (refused): `NC`, `ND`, editorial-only, personal-only,
  Sketchfab *Free Standard*, and any value that does not state a license
  (`LICENSE_MISSING`);
* unknown licenses are errors, not warnings (`LICENSE_NOT_IN_ALLOWLIST`) — an
  unlisted license must be reviewed and added explicitly;
* attribution licences require a licence URL and an attribution string naming the
  creator; placeholder hosts (`example.com`, `localhost`, …) make a source URL
  unverifiable.

Rights are tri-state (`YES`/`NO`/`UNKNOWN`), and the tri-state is not a soft
state: `NO` is refused (`RIGHT_NOT_GRANTED`) and `UNKNOWN` is refused as well
(`RIGHT_UNKNOWN`) — bytes whose rights have not been clarified do not enter the
pipeline at all, so there is nothing to promote later. Softer gaps stay warnings
that block only promotion: `CREATOR_UNKNOWN` ("we do not know who made it") and
`ATTRIBUTION_MISSING_CREATOR` (credit string does not name the creator).

**Inheritance rule:** provenance is verified against the artifact that was
actually obtained (the RAW file). An optimized artifact inherits that verdict, and
the optimization report records the inheritance; the raw evidence stays untouched
in `rawValidationJson`. Re-verifying a source-file checksum against a derived file
would be a false statement in one direction or the other, so it is not done.

## 6. Inventory and structural fingerprints

`buildInventory()` produces one entry per mesh-bearing node:

    path ("Body/Wheel_FL"), nodeName (exactly as authored, "" when unnamed),
    nameSource: AUTHORED | DERIVED_UNNAMED, meshIndex, meshName, primitives,
    triangles, vertices, materials[], visible, bboxMin/bboxMax, fingerprint

* `nameSource` is never inferred: a positional key such as `node[7]` is
  `DERIVED_UNNAMED` and **cannot be mapped** (the studio refuses it).
* `fingerprint` = SHA-256 over the identity of the mesh (name source, mesh name,
  primitive/vertex/triangle counts, index/attribute accessors, material names),
  truncated to 40 hex characters. It is the value a mapping stores; a later
  version whose node has a different fingerprint is *drift*, not a match.
* `inventoryHash` covers the whole inventory and is stored with the version, so
  the state of the geometry at validation time is reconstructible.

## 7. Optimization: measured before/after, with quality gates

`optimizeVersion()` runs the production profile on the stored raw bytes and then
compares the two audits (`compareAudits`):

* hard failures: `OPTIMIZED_INVALID`, `GEOMETRY_EMPTY`, `MATERIALS_DROPPED`,
  `TEXTURES_DROPPED`, `REQUIRED_MESH_MISSING` (a node named by an existing
  mapping disappeared);
* warnings that must be explained: `SIZE_NOT_REDUCED`, `AGGRESSIVE_REDUCTION`,
  `MESH_NAME_LOST`, `TEXTURES_ENLARGED`, `BOUNDS_UNAVAILABLE`,
  `COMPARE_WITHOUT_METRICS` (error).

The deltas are stored in `optimizationJson` (file bytes, triangles, vertices,
textures, materials, per-mesh name census) so a claim like "we reduced it" is
always accompanied by the two numbers it was reduced from.

## 8. Lifecycle and promotion gates

States: `PLACEHOLDER | RAW | VALIDATED | OPTIMIZED | STAGED | VERIFIED |
PRODUCTION | RETIRED | REJECTED`.

Transition rules (`canTransition`):

* `PLACEHOLDER` is terminal for customers — it may only be RETIRED; a synthetic
  stand-in is never promoted (the §22/§3.1 "NO FAKE GLB" rule, enforced in code);
* the pipeline is forward-only, one step at a time: `RAW → VALIDATED →
  OPTIMIZED → STAGED → VERIFIED → PRODUCTION`;
* `REJECTED` is terminal for that artifact; `RETIRED` may only return to
  `PRODUCTION` (rollback) and keeps its immutable object;
* the live `PRODUCTION` version cannot be rejected directly — it must be retired
  by promoting a replacement, so the viewer is never blanked.

`evaluatePromotion()` returns one gate per question; a gate whose evidence is
missing fails. There is no "force" flag.

| Gate | Passes when |
| --- | --- |
| `REAL_ASSET` | `Asset.kind = REAL` |
| `PIPELINE_ORDER` | validated/optimized/staged/verified timestamps all exist |
| `PROVENANCE` | provenance verdict `PASS` on the stored audit |
| `RIGHTS` | commercial + redistribution + modification all granted |
| `ATTRIBUTION` | attribution text present when the licence requires it |
| `CHECKSUM` | stored sha256 + inventoryHash exist |
| `TECHNICAL` | structure verdict `PASS` |
| `SECURITY` | security verdict `PASS` |
| `SELF_CONTAINED` | no external references |
| `PERFORMANCE` | inside `DELIVERY_BUDGET` |
| `RENDER_VERIFICATION` | recorded from Preview/staging, **not** `local-dev` |
| `MAPPING_INTEGRITY` | at least one mapping and zero `MAPPING_INVALID` |
| `RAW_EVIDENCE` | raw audit verdict `PASS` (source preserved) |
| `ROLLBACK_PATH` | previous production version still has its immutable object |

Every state change is written to `AssetEventLog` with actor, from/to state, note
and a JSON detail payload (object key, sha256, gate blockers, drift detail …).

## 9. Evidence storage

`AssetVersion` carries the audit chain, not a summary of it:

    rawValidationJson   audit of the raw artifact (immutable source of truth)
    validationJson      audit of the artifact the viewer consumes
    optimizationJson    measured deltas + inheritance note
    provenanceJson      the validated provenance record
    metadataJson        original filename, download date, notes, metadata URLs
    rawFilePath/Size/ChecksumSha256   the preserved source artifact
    state, verifiedBy, promotionNote, rejectionReason, timestamps…

`MeshMapping` carries `meshFingerprint`, `mappingHealth`, `healthCheckedAt`.

## 10. Storage and access

* Bucket keys are immutable and versioned:
  `uploads/assets/{assetId}/v{n}/raw|optimized/{file}`; an existing key is never
  overwritten (`OBJECT_EXISTS`).
* Runtime writes go to Supabase Storage only — never to `public/` (`local`
  provider is dev-only; in production a missing configuration fails closed with
  `STORAGE_UNAVAILABLE`).
* Stored artifacts are read back through the admin-gated route
  `/api/admin/assets/[assetId]/file?versionId=…`, which streams the object named
  by the DB row (no client-supplied path).

## 11. Truthfulness contract

`describeAvailability()` is the single place that decides what a customer surface
may claim. Only `kind = REAL` **and** `state = PRODUCTION` yields
`vehicle3d = "REAL"`; anything else is `PLACEHOLDER` (or `UNAVAILABLE`). A part is
reported in `mappedPartIds` only when its mapping is `MAPPING_VALID`; untrusted
mappings are exposed by name and reason so the UI can say why.

The UI consumes this (`data-vehicle3d`, `data-zone-display`, `data-part-mapping`
on the viewer; a MAPPED/DEMO_ONLY distinction on part pages) so the demo model can
never be presented as a real Peugeot 206.

## 12. How to run it

    # validation only (no DB, no storage)
    node node_modules/vitest/vitest.mjs run tests/p2j-asset-validation.test.ts

    # registry / lifecycle (local DB)
    node node_modules/vitest/vitest.mjs run tests/asset-registry.test.ts

    # full suite
    node node_modules/vitest/vitest.mjs run

    # operator CLI (see docs/PHASE2-J-MAPPING-REPORT.md §8 for the pipeline order)
    npx -y tsx scripts/p2j-asset-pipeline.mts inbox
    npx -y tsx scripts/p2j-asset-pipeline.mts ingest --file <path> --meta <provenance.json>
    npx -y tsx scripts/p2j-asset-pipeline.mts validate|inventory|optimize|stage|verify|status|promote
    npx -y tsx scripts/p2j-asset-pipeline.mts reconcile   # §35 integrity checks

Non-local database targets require `ALLOW_PROD_PROMOTION=1`; the CLI also refuses
promotion when a gate fails.

## 13. Verified state of this layer

* `tests/p2j-asset-validation.test.ts` — 43 tests: container, structure, security,
  inventory, provenance/rights, comparison, limits; synthetic GLBs are built
  inside the test, so no fixture can silently stand in for a real asset.
* `tests/asset-registry.test.ts` — 10 tests: ingestion RAW/REJECTED, full pipeline
  to PRODUCTION with every gate, rollback with artifact retention, mapping drift,
  placeholder isolation, reconciliation.
* Full suite: 19 files / 272 tests passing on the local golden DB.
* `tsc --noEmit` and `eslint src prisma tests` clean.

## 14. Known limitations

* The production database has **not** yet received the `20260927_p2j_asset_lifecycle`
  migration (applied locally only) — see `PHASE2-J-FINAL-REPORT.md`.
* The Supabase service-role key is not readable in this environment, so the
  production bucket backfill of the tracked v2 object is still pending.
* No real, rights-documented Peugeot 206 file has reached the pipeline yet; the
  real-asset gates (J2–J10) therefore remain unexercised outside of tests, and the
  final status is `BLOCKED` on that single external dependency.
* Mapping health for legacy mappings is `MAPPING_NEEDS_REVIEW`
  (`FINGERPRINT_NOT_RECORDED` / `NO_INVENTORY_FOR_VERSION`): deliberately not
  "valid", because it has not been measured against a real inventory.
