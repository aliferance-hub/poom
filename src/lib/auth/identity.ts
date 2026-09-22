import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, createSession, resolveSession, revokeSession, type SessionRecord } from "@/lib/auth/session";

/**
 * ───────────────────── Identity & authorization (P2-E §5, §7, §14–16) ─────────────────────
 * IdentityProvider abstracts authentication; the session store + role guards are
 * provider-agnostic. The only implementation shipped is DemoIdentityProvider
 * (env-verified phones, DEMO_MODE-gated). Real OTP/password providers plug in
 * behind the same interface without touching commerce/seller/admin code.
 *
 * Authority map: the browser never supplies userId/sellerId/role/verified —
 * every resolver derives identity from the session cookie server-side.
 */

export type Role = "CUSTOMER" | "SELLER" | "ADMIN";

export type AuthenticatedUser = {
  id: string;
  phone: string;
  role: Role;
  status: string;
  sessionId: string;
  sessionExpiresAt: Date;
};

export interface IdentityProvider {
  readonly name: string;
  authenticate(input: { phone: string; code?: string }): Promise<{ ok: true; userId: string } | { ok: false; reason: string }>;
}

export class DemoIdentityProvider implements IdentityProvider {
  readonly name = "demo";

  async authenticate(input: { phone: string; code?: string }) {
    // DEMO only: any request reaching here is already gated by DEMO_MODE in
    // loginWithDemoPhone(). Configured demo identities PLUS real onboarding:
    // a Customer who completed P2-G seller onboarding owns a Seller record and
    // may log in to their portal (their role/ownership is enforced server-side
    // by getAuthenticatedSeller, which only resolves ACTIVE-owned sellers).
    const sellerPhone = process.env.SELLER_LOGIN ?? "";
    const adminPhone = process.env.ADMIN_LOGIN ?? "";
    let role: Role | null =
      input.phone === sellerPhone ? "SELLER" : input.phone === adminPhone ? "ADMIN" : null;

    if (!role) {
      const onboardee = await prisma.user.findUnique({
        where: { phone: input.phone },
        select: { id: true, role: true, seller: { select: { id: true } } },
      });
      // only a real onboarded seller (owner of a Seller row) may log in here
      if (onboardee && onboardee.seller) {
        role = onboardee.role === "CUSTOMER" ? "SELLER" : onboardee.role;
        if (onboardee.role === "CUSTOMER") {
          await prisma.user.update({ where: { id: onboardee.id }, data: { role: "SELLER" } });
        }
      }
    }
    if (!role) return { ok: false as const, reason: "UNKNOWN_DEMO_PHONE" };
    const user = await prisma.user.upsert({
      where: { phone: input.phone },
      update: { role },
      create: { phone: input.phone, role },
    });
    return { ok: true as const, userId: user.id };
  }
}

/** Configuration guard (§13, §54): demo auth must never silently run in production. */
export function isDemoAuthEnabled(): boolean {
  const demoMode = process.env.DEMO_MODE !== "0";
  const production = process.env.NODE_ENV === "production";
  if (production && demoMode) {
    // Explicit escape hatch for local production-mode smoke tests only.
    if (process.env.ALLOW_DEMO_IN_PRODUCTION === "1") return true;
    throw new Error("CONFIG_ERROR: DEMO_MODE is enabled while NODE_ENV=production");
  }
  return demoMode;
}

const SESSION_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
  ...(process.env.NODE_ENV === "production" ? { secure: true } : {}),
};

/** Authenticate via the demo provider and create a server-side session. */
export async function loginWithDemoPhone(phone: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isDemoAuthEnabled()) return { ok: false, reason: "DEMO_AUTH_DISABLED" };
  const provider = new DemoIdentityProvider();
  const result = await provider.authenticate({ phone });
  if (!result.ok) return result;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
  if (user.status === "SUSPENDED" || user.status === "DISABLED") {
    return { ok: false, reason: "ACCOUNT_INACTIVE" };
  }
  const { token } = await createSession(user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, SESSION_OPTIONS);
  return { ok: true };
}

export async function logoutCurrentSession(): Promise<void> {
  const store = await cookies();
  await revokeSession(store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
}

/** Current authenticated user (any role) — null for guests/expired/suspended. */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const store = await cookies();
  const session: SessionRecord | null = await resolveSession(store.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status === "SUSPENDED" || user.status === "DISABLED") return null;
  return {
    id: user.id,
    phone: user.phone,
    role: user.role as Role,
    status: user.status,
    sessionId: session.id,
    sessionExpiresAt: session.expiresAt,
  };
}

/** §16: customer-only guard (admin/seller are NOT customers). */
export async function requireCustomer(): Promise<AuthenticatedUser | null> {
  const user = await getCurrentUser();
  if (!user || user.role !== "CUSTOMER") return null;
  return user;
}

/** §14: admin-only guard. */
export async function requireAdmin(): Promise<AuthenticatedUser | null> {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") return null;
  return user;
}

export type SellerIdentity = {
  userId: string;
  role: "SELLER";
  seller: { id: string; businessName: string; status: string; sellerStatus: string; verified: boolean; rating: number };
};

/**
 * §15: seller identity + seller-status check (suspended/rejected sellers cannot
 * operate the portal even though their account is active).
 */
export async function getAuthenticatedSeller(): Promise<SellerIdentity | null> {
  const user = await getCurrentUser();
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

/** TEST ONLY — session-free identity mirrors (never used by routes). */
export async function sellerIdForUserPhone(phone: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (!user) return null;
  const seller = await prisma.seller.findUnique({ where: { userId: user.id }, select: { id: true } });
  return seller?.id ?? null;
}
