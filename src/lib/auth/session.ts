import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * ───────────────────── Server-side sessions (P2-E §8–10) ─────────────────────
 * The cookie carries a 256-bit random token; the DB stores only its sha256.
 * Guest cart/garage key (`poom_sid`) is a separate, non-identity cookie.
 * Lifetime: 7 days (configurable via SESSION_TTL_DAYS). Revocation on logout;
 * expiry enforced on every lookup. Future-ready: rotation = revoke+reissue.
 */

export const SESSION_COOKIE = "poom_session";
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 7);

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
};

export async function createSession(userId: string): Promise<{ token: string; session: SessionRecord }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  const session = await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
    select: { id: true, userId: true, expiresAt: true },
  });
  return { token, session };
}

/** Resolve a valid (non-expired, non-revoked) session from a raw token. */
export async function resolveSession(token: string | undefined | null): Promise<SessionRecord | null> {
  if (!token) return null;
  const record = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record) return null;
  const now = new Date();
  if (record.revokedAt || record.expiresAt <= now) return null;
  // Touch lastSeenAt opportunistically (best-effort, never blocks auth).
  void prisma.session.update({ where: { id: record.id }, data: { lastSeenAt: now } }).catch(() => undefined);
  return { id: record.id, userId: record.userId, expiresAt: record.expiresAt };
}

export async function revokeSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke every session of a user (suspension / future "logout everywhere"). */
export async function revokeAllSessions(userId: string): Promise<number> {
  const res = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

export function tokenMatches(token: string, hash: string): boolean {
  return safeEqual(hashToken(token), hash);
}
