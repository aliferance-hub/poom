import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createAssetVersion } from "@/lib/asset-registry";
import { assertDemoTrust } from "@/lib/demo-trust"; // AUDIT FIX H2: admin session or explicit demo mode

export const runtime = "nodejs";

const MAX_GLB_BYTES = 25 * 1024 * 1024; // 25 MB MVP cap

function isGlb(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x67 && buf[1] === 0x6c && buf[2] === 0x54 && buf[3] === 0x46;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ assetId: string }> }) {
  try {
    await assertDemoTrust();
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
    return NextResponse.json({ error: "FILE_TOO_LARGE", maxBytes: MAX_GLB_BYTES }, { status: 413 });
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

  let version;
  try {
    version = await createAssetVersion({ assetId, fileBuffer: buf, fileName: file.name, mimeType: file.type || undefined, license });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "ERROR";
    return NextResponse.json({ error: msg }, { status: msg === "ASSET_NOT_FOUND" ? 404 : 500 });
  }

  // Persist under poom/public/<filePath> so the viewer can load it client-side.
  const abs = path.join(process.cwd(), "public", version.filePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buf);

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
