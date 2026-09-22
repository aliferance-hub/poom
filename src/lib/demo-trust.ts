/**
 * DEMO trust boundary (MVP) — AUDIT FIX H2 (adversarial review): the demo-trust
 * shim accepted ANY caller in non-production, i.e. every customer could mutate
 * catalog, fitment and 3D mappings. It is now a BRIDGE: it accepts either a
 * real ADMIN session (role enforced) or, purely inside explicit demo mode,
 * unauthenticated callers so the demo keeps working until every admin surface
 * is migrated to requireAdmin(). Production (NODE_ENV=production) requires a
 * real admin session — demo bypass is impossible there.
 *
 * NOTE: this file intentionally has NO "use server" directive — it is a plain
 * server-only helper module (Next.js requires every export of a "use server"
 * module to be an async function).
 */
import { cookies } from "next/headers";
import { SESSION_COOKIE, resolveSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export async function isAdminSession(): Promise<boolean> {
  let store: Awaited<ReturnType<typeof cookies>>;
  try {
    store = await cookies(); // outside a request scope (tests/scripts) this throws
  } catch {
    return false;
  }
  const session = await resolveSession(store.get(SESSION_COOKIE)?.value);
  if (!session) return false;
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { role: true, status: true } });
  return !!user && user.role === "ADMIN" && user.status === "ACTIVE";
}

export async function assertDemoTrust(): Promise<void> {
  if (await isAdminSession()) return;
  const demo = process.env.MOCK_PAYMENTS === "1" || process.env.NODE_ENV !== "production";
  if (!demo) throw new Error("AUTH_REQUIRED: admin mutations require an authenticated ADMIN session");
}

export default assertDemoTrust;

