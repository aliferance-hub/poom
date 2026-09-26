import { NextRequest, NextResponse } from "next/server";
import { createAssetVersion } from "@/lib/asset-registry";
import { requireAdmin, isDemoAuthEnabled } from "@/lib/auth/identity";
import { StorageError } from "@/lib/storage/types";

export const runtime = "nodejs";

// P2-H (H6): Vercel caps a serverless function request body at 4.5 MB — files
// above ~4.4 MB can never arrive here regardless of our own cap. The route
// threshold is therefore 4 MB; anything larger uses the resumable (TUS) path
// to Supabase Storage (docs/phase2/PHASE2-H-STORAGE.md §7).
const MAX_GLB_BYTES = 4 * 1024 * 1024;

function isGlb(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x67 && buf[1] === 0x6c && buf[2] === 0x54 && buf[3] === 0x46;
}

/**
 * P2-H (H19 hardening): the upload boundary is ADMIN-SESSION-first and fails
 * closed. The demo gate is allowed only when demo auth is genuinely enabled
 * for the environment — a production build with MOCK_PAYMENTS=1 alone (the old
 * assertDemoTrust path) no longer opens this route. Misconfiguration and
 * absence of identity both yield a bare 401; no provider details leak.
 */
async function assertAdminOrDemo(): Promise<void> {
  const admin = await requireAdmin();
  if (admin) return;
  // Throws CONFIG_ERROR in a production build with demo auth enabled and no
  // explicit ALLOW_DEMO_IN_PRODUCTION=1 — that exception must fail closed too.
  if (isDemoAuthEnabled()) return;
  throw new Error("AUTH_REQUIRED");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ assetId: string }> }) {
  try {
    await assertAdminOrDemo();
  } catch {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const { assetId } = await ctx.params;
  let form: FormData;
  try {
    form = await req.formData(); // malformed body → 400, not an unhandled 500
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "FILE_REQUIRED" }, { status: 400 });
  }
  if (file.size > MAX_GLB_BYTES) {
    return NextResponse.json(
      { error: "FILE_TOO_LARGE", maxBytes: MAX_GLB_BYTES, hint: "use resumable upload for large assets" },
      { status: 413 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (!isGlb(buf)) {
    return NextResponse.json({ error: "NOT_A_GLB", hint: "glTF-binary magic bytes (glTF) required" }, { status: 415 });
  }

  // P2-F (F1): full provenance capture. Missing values stay null/UNSPECIFIED —
  // never fabricated — and validateVersion() will REJECT an upload that claims
  // to be a real asset without complete provenance.
  const acquiredAtRaw = String(form.get("acquiredAt") ?? "").trim();
  const acquiredAt = acquiredAtRaw ? new Date(acquiredAtRaw) : null;
  if (acquiredAtRaw && (!acquiredAt || isNaN(acquiredAt.getTime()))) {
    return NextResponse.json({ error: "BAD_ACQUIRED_AT", hint: "ISO-8601 date expected" }, { status: 400 });
  }
  const license = {
    licenseType: String(form.get("licenseType") ?? "") || "UNSPECIFIED",
    licenseUrl: String(form.get("licenseUrl") ?? "") || undefined,
    sourceUrl: String(form.get("sourceUrl") ?? "") || undefined,
    creator: String(form.get("creator") ?? "") || undefined,
    attributionText: String(form.get("attributionText") ?? "") || undefined,
    commercialUse: String(form.get("commercialUse") ?? "") === "true",
    acquiredAt,
    modifications: String(form.get("modifications") ?? "") || undefined,
    intendedUsage: String(form.get("intendedUsage") ?? "") || undefined,
  };

  // P2-H (H5): storage owns the binary — the adapter persists it (Supabase
  // Storage in production, public/ under local dev). This route no longer
  // touches the filesystem and is durable on Vercel.
  let version;
  try {
    version = await createAssetVersion({ assetId, fileBuffer: buf, fileName: file.name, mimeType: file.type || undefined, license });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "ERROR";
    if (e instanceof StorageError || msg.startsWith("STORAGE_") || msg === "INVALID_KEY" || msg === "OBJECT_EXISTS") {
      return NextResponse.json({ error: msg }, { status: 502 });
    }
    return NextResponse.json({ error: msg }, { status: msg === "ASSET_NOT_FOUND" ? 404 : 500 });
  }

  const provenanceComplete = Boolean(
    version.licenseType && version.licenseType !== "UNSPECIFIED" &&
    version.creator && version.acquiredAt && version.intendedUsage,
  );
  return NextResponse.json({
    versionId: version.id,
    version: version.version,
    status: version.status,
    checksum: version.checksumSha256,
    fileSize: version.fileSize,
    licenseType: version.licenseType,
    commercialUse: version.commercialUse,
    provenanceComplete, // incomplete provenance cannot pass validateVersion
  }, { status: 201 });
}
