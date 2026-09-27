// P2-H (H5): local development provider — keeps `npm run dev` working with zero
// configuration by persisting binaries under public/ exactly as the pre-P2-H
// upload route did. NEVER selected in production (see getAssetStorage()).
import { AssetStorage, ObjectMeta, StoredObject, StorageError, assertSafeKey } from "./types";
import { mkdir, writeFile, unlink, stat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export class LocalDevelopmentStorage implements AssetStorage {
  readonly provider = "local-dev";
  readonly bucket = "";
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? path.join(process.cwd(), "public");
  }

  private abs(key: string): string {
    assertSafeKey(key);
    const p = path.resolve(this.root, key);
    // Defense in depth: even with a validated key, guarantee containment.
    if (p !== this.root && !p.startsWith(this.root + path.sep)) {
      throw new StorageError("INVALID_KEY", "escapes public root");
    }
    return p;
  }

  async upload(key: string, data: Uint8Array, opts: { contentType: string }): Promise<StoredObject> {
    const p = this.abs(key);
    await mkdir(path.dirname(p), { recursive: true });
    try {
      // "wx" → refuse to clobber an existing file (immutable paths, H6).
      await writeFile(p, Buffer.from(data), { flag: "wx" });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new StorageError("OBJECT_EXISTS", key);
      }
      throw new StorageError("STORAGE_UPLOAD_FAILED", e instanceof Error ? e.message : "write failed");
    }
    void opts;
    return { key, size: data.byteLength };
  }

  async delete(key: string): Promise<void> {
    const p = this.abs(key);
    try {
      await unlink(p);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // idempotent
      throw new StorageError("STORAGE_DELETE_FAILED", e instanceof Error ? e.message : "delete failed");
    }
  }

  /** Dev-only absolute URL served by `next dev` from public/. */
  getPublicUrl(key: string): string {
    this.abs(key);
    return `/${key}`;
  }

  async createSignedUrl(key: string, _expiresInSec: number): Promise<string> {
    void _expiresInSec;
    return this.getPublicUrl(key); // dev: everything is public
  }

  async createSignedUploadUrl(_key: string, _expiresInSec: number): Promise<string | null> {
    return null; // resumable upload is a Supabase-only capability
  }

  async exists(key: string): Promise<boolean> {
    return (await this.metadata(key)) !== null;
  }

  /** P2-J: read the stored bytes back (dev mirrors the production contract). */
  async download(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.abs(key)));
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new StorageError("OBJECT_NOT_FOUND", key);
      throw new StorageError("STORAGE_UNAVAILABLE", e instanceof Error ? e.message : "read failed");
    }
  }

  async metadata(key: string): Promise<ObjectMeta | null> {
    try {
      const s = await stat(this.abs(key));
      return { size: s.size, contentType: null, lastModified: s.mtime };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StorageError("STORAGE_UNAVAILABLE", e instanceof Error ? e.message : "stat failed");
    }
  }

  async listKeys(prefix = ""): Promise<string[]> {
    const base = path.resolve(this.root, prefix);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing dir → empty list
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(path.relative(this.root, p).split(path.sep).join("/"));
      }
    };
    await walk(base);
    return out;
  }
}
