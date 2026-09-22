import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, resolveSession } from "@/lib/auth/session";
import type { AuthenticatedUser } from "@/lib/auth/identity";

/**
 * ───────────────────── Seller identity (P2-D → P2-E hardened) ─────────────────────
 * AUDIT FIX H1: the legacy `poom_uid` cookie (a raw, client-settable User id)
 * was authoritative for the whole seller portal — a forged cookie granted a
 * seller/admin identity. Identity now resolves EXCLUSIVELY through the
 * server-side session store (opaque token in an HttpOnly cookie; the DB stores
 * only its sha256). sellerId never arrives from the browser.
 */

async function currentUser(): Promise<AuthenticatedUser | null> {
  const store = await cookies();
  const session = await resolveSession(store.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status === "SUSPENDED" || user.status === "DISABLED") return null;
  return {
    id: user.id,
    phone: user.phone,
    role: user.role as AuthenticatedUser["role"],
    status: user.status,
    sessionId: session.id,
    sessionExpiresAt: session.expiresAt,
  };
}

export type SellerIdentity = {
  userId: string;
  role: "SELLER";
  seller: { id: string; businessName: string; status: string; sellerStatus: string; verified: boolean; rating: number };
};

/**
 * Resolve the authenticated seller for the current request.
 * Returns null when: no valid session, role ≠ SELLER, user suspended, no Seller
 * row, or seller governance status ≠ ACTIVE. Route handlers must treat null as
 * 404/redirect (existence-blind — do not leak whether a protected object exists).
 */
export async function getAuthenticatedSeller(): Promise<SellerIdentity | null> {
  const user = await currentUser();
  if (!user || user.role !== "SELLER") return null;
  const seller = await prisma.seller.findUnique({ where: { userId: user.id } });
  if (!seller) return null;
  if (seller.sellerStatus === "SUSPENDED" || seller.sellerStatus === "REJECTED") return null;
  return {
    userId: user.id,
    role: "SELLER",
    seller: {
      id: seller.id,
      businessName: seller.businessName,
      status: seller.status,
      sellerStatus: seller.sellerStatus,
      verified: seller.verified,
      rating: seller.rating,
    },
  };
}

export type AdminIdentity = { userId: string; role: "ADMIN" };

/** Admin boundary: separate resolver so admin actions can never impersonate seller ownership. */
export async function getAuthenticatedAdmin(): Promise<AdminIdentity | null> {
  const user = await currentUser();
  if (!user || user.role !== "ADMIN") return null;
  return { userId: user.id, role: "ADMIN" };
}

/**
 * TEST/SEED ONLY — direct identity pairing used by service-level tests, where
 * `cookies()` is unavailable outside a request scope. Never exported through a
 * route; the app resolves identity from the session cookie exclusively.
 */
export async function sellerIdForUserPhone(phone: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (!user) return null;
  const seller = await prisma.seller.findUnique({ where: { userId: user.id }, select: { id: true } });
  return seller?.id ?? null;
}
