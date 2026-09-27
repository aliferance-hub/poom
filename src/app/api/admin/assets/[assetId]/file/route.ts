import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isDemoAuthEnabled } from "@/lib/auth/identity";
import { getAssetStorage } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

export const runtime = "nodejs";

/**
 * P2-J (J12): stream one stored artifact to the Mapping Studio so an admin can
 * inspect the real file in any environment (local dev, Preview, production)
 * without exposing a privileged storage credential to the browser.
 *
 * Authorization is the admin session (or the explicit demo gate, matching the
 * upload route); the object key itself never comes from the request — it is read
 * from the version row, so no caller can steer which object is served.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ assetId: string }> }) {
  let authorized = false;
  try {
    authorized = Boolean(await requireAdmin()) || isDemoAuthEnabled();
  } catch {
    authorized = false;
  }
  if (!authorized) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const { assetId } = await ctx.params;
  const versionId = new URL(req.url).searchParams.get("versionId");
  if (!versionId) return NextResponse.json({ error: "VERSION_REQUIRED" }, { status: 400 });

  const version = await prisma.assetVersion.findFirst({
    where: { id: versionId, asset: { assetId } },
    select: { filePath: true, mimeType: true, checksumSha256: true, state: true },
  });
  if (!version) return NextResponse.json({ error: "VERSION_NOT_FOUND" }, { status: 404 });
  if (!version.filePath || version.filePath.startsWith("builtin:") || version.filePath.startsWith("rejected:")) {
    return NextResponse.json({ error: "NO_STORED_ARTIFACT" }, { status: 404 });
  }

  try {
    const bytes = await getAssetStorage().download(version.filePath);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": version.mimeType ?? "model/gltf-binary",
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=0, must-revalidate",
        ...(version.checksumSha256 ? { etag: `"${version.checksumSha256.slice(0, 32)}"` } : {}),
      },
    });
  } catch (e) {
    const code = e instanceof StorageError ? e.code : "STORAGE_UNAVAILABLE";
    return NextResponse.json({ error: code }, { status: code === "OBJECT_NOT_FOUND" ? 404 : 502 });
  }
}
