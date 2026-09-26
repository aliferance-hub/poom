// P2-H (H5): Supabase Storage provider — plain fetch against /storage/v1,
// service-role key, SERVER-SIDE ONLY. No SDK dependency by design.
import { AssetStorage, ObjectMeta, StoredObject, StorageError, assertSafeKey, encodeKeyPath } from "./types";

type SupabaseConfig = { url: string; serviceKey: string; bucket: string };

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function unwrap(resp: Response, code: StorageError["code"]): Promise<Response> {
  if (resp.ok) return resp;
  let detail = "";
  try {
    detail = (await resp.text()).slice(0, 200);
  } catch {
    /* keep empty detail */
  }
  if (resp.status === 404) throw new StorageError("OBJECT_NOT_FOUND", detail);
  if (resp.status === 409) throw new StorageError("OBJECT_EXISTS", detail);
  throw new StorageError(code, `HTTP ${resp.status} ${detail}`);
}

export class SupabaseStorage implements AssetStorage {
  readonly provider = "supabase";
  readonly bucket: string;
  private readonly base: string;
  private readonly key: string;

  constructor(cfg: SupabaseConfig) {
    if (!cfg.url || !cfg.serviceKey) throw new StorageError("STORAGE_UNAVAILABLE", "missing Supabase config");
    this.base = `${trimTrailingSlash(cfg.url)}/storage/v1`;
    this.key = cfg.serviceKey;
    this.bucket = cfg.bucket;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.key}`, ...extra };
  }

  async upload(key: string, data: Uint8Array, opts: { contentType: string }): Promise<StoredObject> {
    assertSafeKey(key);
    // x-upsert:false → an existing object key yields 409 instead of a silent overwrite.
    const resp = await fetch(`${this.base}/object/${this.bucket}/${encodeKeyPath(key)}`, {
      method: "POST",
      headers: this.headers({ "content-type": opts.contentType, "x-upsert": "false" }),
      body: Buffer.from(data),
    });
    await unwrap(resp, "STORAGE_UPLOAD_FAILED");
    const etag = resp.headers.get("etag") ?? undefined;
    return { key, size: data.byteLength, etag };
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    // Idempotent by contract: a 404 from the storage API is success for delete.
    const resp = await fetch(`${this.base}/object/${this.bucket}/${encodeKeyPath(key)}`, {
      method: "DELETE",
      headers: this.headers(),
    }).catch((e: unknown) => {
      throw new StorageError("STORAGE_DELETE_FAILED", e instanceof Error ? e.message : "network error");
    });
    if (!resp.ok && resp.status !== 404) await unwrap(resp, "STORAGE_DELETE_FAILED");
  }

  getPublicUrl(key: string): string {
    assertSafeKey(key);
    return `${this.base}/object/public/${this.bucket}/${encodeKeyPath(key)}`;
  }

  async createSignedUrl(key: string, expiresInSec: number): Promise<string> {
    assertSafeKey(key);
    const resp = await fetch(`${this.base}/object/sign/${this.bucket}/${encodeKeyPath(key)}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ expiresIn: expiresInSec }),
    }).catch((e: unknown) => {
      throw new StorageError("STORAGE_SIGN_FAILED", e instanceof Error ? e.message : "network error");
    });
    const body = (await unwrap(resp, "STORAGE_SIGN_FAILED").then((r) => r.json())) as { signedURL?: string };
    if (!body.signedURL) throw new StorageError("STORAGE_SIGN_FAILED", "no signedURL in response");
    return `${this.base}${body.signedURL}`;
  }

  async createSignedUploadUrl(key: string, _expiresInSec: number): Promise<string | null> {
    // TUS-style resumable upload endpoint (H6). The token is appended by the
    // client per Supabase resumable-upload protocol; returned URL is short-lived.
    assertSafeKey(key);
    const resp = await fetch(`${this.base}/object/upload/sign/${this.bucket}/${encodeKeyPath(key)}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ expiresIn: _expiresInSec }),
    }).catch((e: unknown) => {
      throw new StorageError("STORAGE_SIGN_FAILED", e instanceof Error ? e.message : "network error");
    });
    const body = (await unwrap(resp, "STORAGE_SIGN_FAILED").then((r) => r.json())) as { url?: string; token?: string };
    if (!body.url && !body.token) throw new StorageError("STORAGE_SIGN_FAILED", "no upload sign data");
    return body.url ? (body.url.startsWith("http") ? body.url : `${this.base}${body.url}`) : `${this.base}/object/upload/sign/${this.bucket}/${encodeKeyPath(key)}?token=${body.token}`;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.metadata(key)) !== null;
  }

  async listKeys(prefix = ""): Promise<string[]> {
    const out: string[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const url = new URL(`${this.base}/object/list/${this.bucket}`);
      if (prefix) url.searchParams.set("prefix", prefix);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("sortBy", JSON.stringify({ column: "name", order: "asc" }));
      const resp = await fetch(url, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ prefix, limit, offset, sortBy: { column: "name", order: "asc" } }),
      }).catch((e: unknown) => {
        throw new StorageError("STORAGE_UNAVAILABLE", e instanceof Error ? e.message : "network error");
      });
      const rows = (await unwrap(resp, "STORAGE_UNAVAILABLE").then((r) => r.json())) as Array<{
        name?: string; id?: string | null;
      }>;
      for (const row of rows) {
        // Folders come back with id:null; recurse by prefix.
        if (!row.name) continue;
        const full = prefix ? `${prefix.replace(/\/+$/, "")}/${row.name}` : row.name;
        if (row.id === null) {
          out.push(...(await this.listKeys(`${full}/`)));
        } else {
          out.push(full);
        }
      }
      if (rows.length < limit) break;
      offset += limit;
    }
    return out;
  }

  async metadata(key: string): Promise<ObjectMeta | null> {
    assertSafeKey(key);
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/object/info/${this.bucket}/${encodeKeyPath(key)}`, {
        method: "GET",
        headers: this.headers(),
      });
    } catch (e: unknown) {
      throw new StorageError("STORAGE_UNAVAILABLE", e instanceof Error ? e.message : "network error");
    }
    if (resp.status === 404) return null;
    const body = (await unwrap(resp, "STORAGE_UNAVAILABLE").then((r) => r.json())) as {
      size?: number; mimeType?: string; updated_at?: string; created_at?: string;
    };
    const last = body.updated_at ?? body.created_at ?? null;
    return {
      size: body.size ?? 0,
      contentType: body.mimeType ?? null,
      lastModified: last ? new Date(last) : null,
    };
  }
}
