// P2-H (H5): storage provider contract. Business logic depends only on this
// interface — never on Supabase specifics or on the filesystem.
// Design of record: docs/phase2/PHASE2-H-STORAGE.md

export type StoredObject = { key: string; size: number; etag?: string };

export type ObjectMeta = {
  size: number;
  contentType: string | null;
  lastModified: Date | null;
};

export interface AssetStorage {
  /** Provider id, e.g. "supabase" | "local-dev" (exposed for diagnostics only). */
  readonly provider: string;
  /** Bucket/container name ("" for the local filesystem provider). */
  readonly bucket: string;
  upload(key: string, data: Uint8Array, opts: { contentType: string }): Promise<StoredObject>;
  /** Idempotent: deleting a missing object is a no-op, not an error. */
  delete(key: string): Promise<void>;
  /** Absolute URL the browser may fetch (public bucket or dev-static). */
  getPublicUrl(key: string): string;
  /** Short-TTL signed URL for restricted delivery (private asset classes). */
  createSignedUrl(key: string, expiresInSec: number): Promise<string>;
  /** Signed RESUMABLE upload URL for large files (H6); null when unsupported. */
  createSignedUploadUrl(key: string, expiresInSec: number): Promise<string | null>;
  exists(key: string): Promise<boolean>;
  metadata(key: string): Promise<ObjectMeta | null>;
  /** All object keys under a prefix (recursive) — reconciliation support (H8). */
  listKeys(prefix?: string): Promise<string[]>;
}

/** Deterministic storage failures — routes map codes to fixed HTTP statuses. */
export class StorageError extends Error {
  code:
    | "INVALID_KEY"
    | "OBJECT_EXISTS"
    | "OBJECT_NOT_FOUND"
    | "STORAGE_UPLOAD_FAILED"
    | "STORAGE_DELETE_FAILED"
    | "STORAGE_SIGN_FAILED"
    | "STORAGE_UNAVAILABLE"
    | "NOT_SUPPORTED";

  constructor(code: StorageError["code"], detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StorageError";
    this.code = code;
  }
}

/**
 * H7 hardening: the object key is built from DB-validated assetId + numeric
 * version + a sanitized file name — but the adapter never trusts its caller.
 * Rejects traversal ("..", absolute, backslash, "."" segments), null bytes,
 * control characters and percent-encoded traversal tricks.
 */
export function assertSafeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw new StorageError("INVALID_KEY", "empty or oversized");
  }
  if (/[\0\\]/.test(key)) throw new StorageError("INVALID_KEY", "null byte or backslash");
  if (/[\u0001-\u001f\u007f]/.test(key)) throw new StorageError("INVALID_KEY", "control character");
  if (/^\/+/.test(key) || key.includes("//")) throw new StorageError("INVALID_KEY", "absolute or double slash");
  const lower = key.toLowerCase();
  if (lower.includes("%2e%2e") || lower.includes("%2f") || lower.includes("%00")) {
    throw new StorageError("INVALID_KEY", "encoded traversal");
  }
  for (const seg of key.split("/")) {
    if (seg.length === 0 || seg === "." || seg === "..") {
      throw new StorageError("INVALID_KEY", `bad segment "${seg}"`);
    }
  }
  return key;
}

/** Encode a validated key for use in a URL path (per-segment). */
export function encodeKeyPath(key: string): string {
  return assertSafeKey(key)
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}
