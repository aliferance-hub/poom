"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { loginWithDemoPhone, logoutCurrentSession, isDemoAuthEnabled } from "@/lib/auth/identity";
import { rateLimiter, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { logAudit } from "@/lib/audit";

/**
 * P2-E login/logout. Demo authentication is DEMO_MODE-gated (startup guard in
 * identity.ts) and rate-limited; sessions are server-side records with hashed
 * tokens. A real OTP/password provider plugs behind IdentityProvider later.
 */
export async function demoLoginAction(formData: FormData) {
  const phone = String(formData.get("phone") ?? "").trim();
  const next = String(formData.get("next") ?? "/seller");

  if (!/^0\d{9,10}$/.test(phone)) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }

  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = await rateLimiter.check(`login:${ip}:${phone}`, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMs);
  if (!rl.allowed) {
    redirect(`/login?error=rate&next=${encodeURIComponent(next)}`);
  }

  if (!isDemoAuthEnabled()) {
    redirect(`/login?error=disabled&next=${encodeURIComponent(next)}`);
  }

  const result = await loginWithDemoPhone(phone);
  if (!result.ok) {
    await logAudit({ actor: `guest:${phone.slice(-4)}`, event: "user_login_failed", entity: "Session", meta: { reason: result.reason } });
    redirect(`/login?error=${result.reason === "ACCOUNT_INACTIVE" ? "inactive" : 1}&next=${encodeURIComponent(next)}`);
  }

  const user = await (await import("@/lib/prisma")).prisma.user.findUniqueOrThrow({ where: { phone } });
  await logAudit({ actor: user.id, event: "user_login", entity: "Session", meta: { provider: "demo" } });
  redirect(next.startsWith("/") ? next : "/seller");
}

export async function demoLogoutAction() {
  await logoutCurrentSession();
  await logAudit({ actor: "unknown", event: "user_logout", entity: "Session" });
  redirect("/");
}
