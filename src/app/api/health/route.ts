import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * P2-H (H16): liveness + coarse dependency health.
 * Returns NO secrets, NO topology, NO error details — only safe booleans.
 * A failing dependency yields HTTP 503 with a bare status object (usable by
 * uptime monitors) while never leaking credentials, hostnames or stack traces.
 */
export async function GET() {
  let db = false;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
    ]);
    db = true;
  } catch {
    db = false; // swallowed by design: details must not leak here (H17)
  }

  const body = { status: db ? "ok" : "degraded", checks: { db } };
  return NextResponse.json(body, { status: db ? 200 : 503 });
}
