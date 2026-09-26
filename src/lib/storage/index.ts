// P2-H (H5): configuration-driven provider selection.
// Production/Preview (Vercel) → Supabase Storage with the service-role key.
// Local dev (no Supabase env) → filesystem under public/, as before P2-H.
import type { AssetStorage } from "./types";
import { StorageError } from "./types";
import { SupabaseStorage } from "./supabase";
import { LocalDevelopmentStorage } from "./local";
import { InMemoryStorage } from "./memory";

let cached: AssetStorage | null = null;

export function getAssetStorage(): AssetStorage {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "";
  const bucket = process.env.ASSET_BUCKET ?? "assets";

  if (url && serviceKey) {
    cached = new SupabaseStorage({ url, serviceKey, bucket });
  } else if (process.env.NODE_ENV === "test") {
    cached = new InMemoryStorage(); // hermetic suite — no filesystem writes
  } else if (process.env.NODE_ENV === "production") {
    // Fail closed in production: never silently fall back to ephemeral disk.
    throw new StorageError(
      "STORAGE_UNAVAILABLE",
      "Supabase Storage not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)",
    );
  } else {
    cached = new LocalDevelopmentStorage();
  }
  return cached;
}

/** Test seam: inject a provider and restore the previous one afterwards. */
export function setAssetStorageForTests(storage: AssetStorage | null): void {
  cached = storage;
}
