// P2-H (H5/H8): in-memory provider — hermetic default for the test suite and a
// fixture for storage tests. Never selected outside NODE_ENV=test.
import { AssetStorage, ObjectMeta, StoredObject, StorageError, assertSafeKey } from "./types";

export class InMemoryStorage implements AssetStorage {
  readonly provider = "memory";
  readonly bucket = "assets";
  private readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();

  async upload(key: string, data: Uint8Array, opts: { contentType: string }): Promise<StoredObject> {
    assertSafeKey(key);
    if (this.objects.has(key)) throw new StorageError("OBJECT_EXISTS", key);
    this.objects.set(key, { data: data.slice(), contentType: opts.contentType });
    return { key, size: data.byteLength };
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    this.objects.delete(key); // idempotent
  }

  getPublicUrl(key: string): string {
    assertSafeKey(key);
    return `/${key}`;
  }

  async createSignedUrl(key: string, _expiresInSec: number): Promise<string> {
    void _expiresInSec;
    return this.getPublicUrl(key);
  }

  async createSignedUploadUrl(_key: string, _expiresInSec: number): Promise<string | null> {
    return null;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(assertSafeKey(key));
  }

  async metadata(key: string): Promise<ObjectMeta | null> {
    const hit = this.objects.get(assertSafeKey(key));
    if (!hit) return null;
    return { size: hit.data.byteLength, contentType: hit.contentType, lastModified: null };
  }

  async listKeys(prefix = ""): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }

  /** Test helper: number of stored objects (reconciliation assertions). */
  get size(): number {
    return this.objects.size;
  }
}
