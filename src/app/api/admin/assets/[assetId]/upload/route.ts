import { NextRequest, NextResponse } from "next/server";
import { createAssetVersion, type ProvenanceInput } from "@/lib/asset-registry";
import { requireAdmin, isDemoAuthEnabled } from "@/lib/auth/identity";
import { StorageError } from "@/lib/storage/types";

export const runtime = "nodejs";

// P2-H (H6): Vercel caps a serverless function request body at 4.5 MB — files
// above ~4.4 MB can never arrive here regardless of our own cap. The route
// threshold is therefore 4 MB; larger sources are ingested through the P2-J CLI
// (`scripts/p2j-asset-pipeline.mts ingest`), which streams from disk to the
// Storage API instead of through a function body.
const MAX_GLB_BYTES = 4 * 1024 * 1024;

function isGlb(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x67 && buf[1] === 0x6c && buf[2] === 0x54 && buf[3] === 0x46;
}

/**
 * P2-H (H19 hardening)/P2-J: ADMIN-SESSION-first, fails closed. This route now
 * only performs RAW ingestion — a file that passes the audit waits in RAW state
 * until an operator (or the CLI) runs it through the promotion pipeline.
 */
async function assertAdminOrDemo(): Promise<void> {
  const admin = await requireAdmin();
  if (admin) return;
  if (isDemoAuthEnabled()) return;
  throw new Error("AUTH_REQUIRED");
}

const TRI: ("YES" | "NO" | "UNKNOWN")[] = ["YES", "NO", "UNKNOWN"];

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
      { error: "FILE_TOO_LARGE", maxBytes: MAX_GLB_BYTES, hint: "use the P2-J CLI ingestion path for large source files" },
      { status: 413 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (!isGlb(buf)) {
    return NextResponse.json({ error: "NOT_A_GLB", hint: "glTF-binary magic bytes (glTF) required" }, { status: 415 });
  }

  // P2-J (§5): every field is captured verbatim; a missing value is passed on as
  // UNKNOWN/empty and the audit decides whether the file may be stored at all.
  const text = (key: string): string => String(form.get(key) ?? "").trim();
  const tri = (key: string): "YES" | "NO" | "UNKNOWN" => {
    const raw = text(key).toUpperCase();
    return (TRI as string[]).includes(raw) ? (raw as "YES" | "NO" | "UNKNOWN") : "UNKNOWN";
  };

  const downloadDate = text("downloadDate") || text("acquiredAt");
  const provenance: ProvenanceInput = {
    assetIdentity: text("assetIdentity"),
    sourceUrl: text("sourceUrl"),
    sourceProvider: text("sourceProvider"),
    creator: text("creator") || null,
    licenseType: text("licenseType"),
    licenseUrl: text("licenseUrl") || null,
    commercialUse: tri("commercialUse"),
    redistributionAllowed: tri("redistributionAllowed"),
    modificationAllowed: tri("modificationAllowed"),
    attributionText: text("attributionText") || null,
    downloadDate,
    originalFilename: file.name,
    intendedUsage: text("intendedUsage"),
    modifications: text("modifications") || null,
    notes: text("notes") || null,
    variantClaim: text("variantClaim") || null,
  };

  try {
    const result = await createAssetVersion({
      assetId,
      fileBuffer: buf,
      fileName: file.name,
      mimeType: file.type || undefined,
      provenance,
      actor: "admin:upload-route",
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.error === "ASSET_NOT_FOUND" ? 404 : 502 });
    }
    const errorProblems = result.audit.problems.filter((p) => p.severity === "error");
    const status = result.outcome === "RAW" ? 201 : 422;
    return NextResponse.json(
      {
        versionId: result.versionId,
        version: result.version,
        outcome: result.outcome, // RAW = stored and awaiting the pipeline, REJECTED = never stored
        auditVerdict: result.audit.verdict,
        sha256: result.audit.sha256,
        fileSize: result.audit.byteLength,
        counts: result.audit.counts,
        metrics: result.audit.metrics,
        problems: errorProblems.map((p) => `${p.code}${p.where ? `:${p.where}` : ""}`),
        provenanceVerdict: result.audit.provenance,
        rights: result.audit.rights,
        note: "RAW ingestion only: validation, optimization, staging and promotion run through the P2-J pipeline.",
      },
      { status },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "ERROR";
    if (e instanceof StorageError || msg.startsWith("STORAGE_") || msg === "INVALID_KEY" || msg === "OBJECT_EXISTS") {
      return NextResponse.json({ error: msg }, { status: 502 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
