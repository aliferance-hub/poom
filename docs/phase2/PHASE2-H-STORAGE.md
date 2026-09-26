# P2-H — Supabase Storage Architecture (H4) + Large GLB Strategy (H6)

Decisions and rationale for the production asset pipeline. The storage
**implementation** lands in H5; this document is the design of record.

---

## 1. Target flow

```
Admin (browser)
  → authenticated server boundary (assertDemoTrust / admin session)
  → upload validation (size, magic bytes, provenance)
  → Supabase Storage  (bucket: assets, immutable versioned object key)
  → AssetVersion row  (filePath = object key, checksum, license metadata)
  → resolveContract() derives fileUrl → 3D Viewer (GLTFLoader)
```

**PostgreSQL stores metadata only. Binary never enters the database.**

## 2. Ownership boundary

| Concern | Owner |
| --- | --- |
| Asset / AssetVersion / provenance / validation / activation / mapping | Asset Registry (`src/lib/asset-registry.ts`) + DB |
| Binary bytes, object keys, URLs (public/signed), existence checks | Storage adapter (`src/lib/storage/`) |

The DB keeps `filePath` as the canonical **object key**
(`uploads/assets/<assetId>/v<n>/<file>`). URLs are **derived**, never stored
long-term as absolute values — so switching provider or bucket does not touch
data. `resolveContract()` computes `fileUrl` through the adapter at request time.

## 3. Bucket strategy

| Bucket | Access | Purpose | Status |
| --- | --- | --- | --- |
| `assets` | **public read** | 3D viewer geometry (GLB) served to every visitor | **created in P2-H** (via `storage.buckets` insert — the only one-time SQL provisioning step; all object operations go through the Storage API) |
| `part-images` | public read (future) | part photos for PDP/gallery | defined only — no uploader exists yet; do not create |
| `seller-uploads` | **private** (future) | seller verification documents | defined only — created when seller onboarding needs it |
| `admin-private` | private (future) | internal-only restricted-license assets | defined only — created when a restricted asset actually arrives |

No bucket is created "just in case". Buckets are additive and cheap to create
later; the adapter makes the switch a config change.

## 4. Access model — why `assets` is public read

- GLB files are rendered **client-side by every anonymous visitor**; public read
  lets GLTFLoader fetch them directly with CDN caching. Signed URLs would add a
  server round-trip per load, expire mid-session, and break cache keys.
- What is protected is not secrecy of bytes but **provenance integrity**:
  commercial-use licensing, attribution, and activation rules are enforced by
  the Asset Registry (validateVersion rejects incomplete provenance; only READY
  versions with mappings can go ACTIVE). Licensing metadata lives in the DB,
  not in the file.
- Immutable, content-versioned paths (`uploads/assets/<assetId>/v<n>/…`) mean a
  new version is a **new object**; overwriting an existing object key is
  rejected by the adapter. Rollback = re-activate an old version whose object
  still exists.
- If a restricted-license asset ever arrives: adapter exposes
  `createSignedUrl()`; that asset class moves to `admin-private` with short-TTL
  signed delivery. The adapter, not the code paths, carries the difference.

**Service-role key never reaches the browser.** All storage calls with the
secret key happen server-side (route handlers / server actions). The browser
only ever receives final public URLs (or short-TTL signed URLs in future).

## 5. Storage adapter contract

Configuration-driven provider selection — no business logic depends on
provider specifics:

```ts
interface AssetStorage {
  upload(key, data, { contentType }): Promise<{ key; size; etag? }>
  delete(key): Promise<void>
  getPublicUrl(key): string
  createSignedUrl(key, expiresInSec): Promise<string>
  exists(key): Promise<boolean>
  metadata(key): Promise<{ size; contentType; lastModified } | null>
}
```

| Provider | Active when | Behavior |
| --- | --- | --- |
| `SupabaseStorage` | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` present (prod/preview) | REST API, service key, server-side only |
| `LocalDevelopmentStorage` | otherwise (local dev) | `public/` filesystem as today; keeps `npm run dev` working with zero config |

No new runtime dependency: Supabase Storage is used through plain `fetch`
against `/storage/v1/*` (Node 22 global fetch). The SDK is unnecessary for
upload/download/sign operations and is deliberately not added.

## 6. Consistency boundary (Storage ↔ PostgreSQL)

No distributed transactions. Explicit compensating behavior:

- **Write order**: upload object first → then `AssetVersion` DB row.
  A failed DB write after a successful upload leaves an **orphan object**
  (detectable, harmless — the viewer only renders DB-referenced files).
- **Duplicate upload retry** uploads to the same immutable key → adapter
  rejects overwrite; route surfaces `OBJECT_EXISTS`, client retries with the
  next version number.
- **Reconciliation checks** (data-quality, H8): count mismatches between
  `AssetVersion.filePath` (non-`builtin:`) and storage objects:
  `asset_versions_without_storage`, `storage_objects_without_asset_version`,
  `active_asset_without_storage`.
- Metadata needed to reconcile: object key ↔ `AssetVersion.filePath`,
  size ↔ `fileSize`, content-type ↔ `mimeType`, checksum ↔ `checksumSha256`.
- Storage bookkeeping is never manipulated directly via SQL on `storage.*`
  tables — only through the Storage REST API.

## 7. Large GLB upload strategy (H6)

**Constraint (measured reality of the platform):** Vercel limits a serverless
function request body to **4.5 MB**. The current route caps at 25 MB — anything
above ~4.4 MB **cannot arrive** at a Vercel function regardless of our own cap.
This is a platform fact, not a tuning knob.

**Threshold: 4 MB.**
Rationale: safely below the 4.5 MB platform body limit, leaving headroom for
multipart framing and the provenance form fields; verified against Vercel's
documented limit rather than guessed.

| File size | Path |
| --- | --- |
| ≤ 4 MB | Existing route → server validates → server uploads to Storage (service key) |
| > 4 MB | **Resumable upload (TUS) directly to Supabase Storage from the browser** |

Resumable flow (prepared in P2-H; client TUS integration lands when the first
real >4 MB GLB is acquired — the server side is shipped):

```
server: mint signed upload URL  POST /storage/v1/object/upload/sign/assets/<key>
        (service key, server-side; returns short-lived {url, token})
browser: TUS upload (progress / retry / resume) straight to Supabase
server: finalize → adapter.exists() + size + content-type check
        → AssetVersion DRAFT → provenance validation → READY
```

Properties required by the phase: progress ✅ (TUS native), retry/resume ✅
(TUS native), unique object path ✅ (versioned keys, no overwrite), checksum ✅
(sha256 recorded; TUS uploads verified by size + content-type + re-hash on
finalize when practical), MIME validation ✅ (server-side, magic bytes),
file-size validation ✅ (server-side cap from DB-driven config),
provenance + versioning ✅ (unchanged registry rules).

## 7b. Rollout status & the service-key provisioning constraint (actual P2-H state)

- Bucket `assets` (public read): **CREATED** on 2026-09-26.
- Backfill of the legacy tracked v2 GLB (`uploads/assets/peugeot-206-main-v1/v2/…`):
  **PENDING** — deliberately deferred. The Vercel env API returns `type=sensitive`
  values (SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY) as never-readable, and
  no plaintext copy exists locally, so a local backfill cannot authenticate.
  The production runtime, by contrast, receives the key at build/run time.
  Design consequence: `resolveContract()` attempts storage resolution and
  **falls back to the web-root path when the object is absent** — the live
  viewer keeps rendering — and `reconcileStorage()` reports the row under
  `asset_versions_without_storage` until the backfill happens. First occurrence
  triggers: run the backfill from any environment that holds the service key
  (e.g. a one-off Vercel-hosted script or a maintainer's machine), verifying
  key equality with the DB `filePath`. New uploads (post-P2-H) land in storage
  directly — they never need this fallback.

## 8. Server-side validation authority (feeds H7)

The browser is never trusted for: MIME type, size, ownership, asset identity,
role. The upload route re-derives everything server-side: glTF magic bytes,
size cap, `assertDemoTrust()`, asset existence, sanitized key. Storage errors
are mapped to deterministic responses — no raw provider errors, no stack
traces to the client.
