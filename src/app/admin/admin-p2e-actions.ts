"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";
import { transitionSellerStatus, setSellerVerificationStatus } from "@/lib/governance";
import type { SellerStatus } from "@prisma/client";

const ALLOWED: SellerStatus[] = ["ACTIVE", "SUSPENDED", "REJECTED", "PENDING"];

// P2-G.1: the verification decision vocabulary is whitelisted server-side;
// a forged `to` value never reaches the service (BAD_INPUT, not a crash).
const ALLOWED_VERIFICATION = ["VERIFIED", "PENDING_REVIEW", "UNVERIFIED", "REJECTED"] as const;
type VerificationTarget = (typeof ALLOWED_VERIFICATION)[number];

export async function transitionSellerStatusAction(formData: FormData) {
  const admin = await requireAdmin();
  if (!admin) redirect("/login?next=/admin/sellers");

  const sellerId = String(formData.get("sellerId") ?? "");
  const to = String(formData.get("to") ?? "") as SellerStatus;
  if (!sellerId || !ALLOWED.includes(to)) redirect("/admin/sellers?error=BAD_INPUT");

  const res = await transitionSellerStatus({ sellerId, to, adminUserId: admin.id });
  if (!res.ok) {
    redirect(`/admin/sellers?error=${encodeURIComponent(res.reason)}`);
  }
  revalidatePath("/admin/sellers");
  revalidatePath("/admin");
  redirect("/admin/sellers");
}

/**
 * P2-G.1: admin verification decision.
 * Authority: requireAdmin (session-derived) is the ONLY gate — sellerId / to /
 * note arrive from the form but are only ever interpreted as a target decision,
 * never as identity or origin. A forged origin/role/actor field is ignored:
 * this action constructs the service input itself.
 */
export async function setSellerVerificationAction(formData: FormData) {
  const admin = await requireAdmin();
  if (!admin) redirect("/login?next=/admin/sellers");

  const sellerId = String(formData.get("sellerId") ?? "");
  const rawTo = String(formData.get("to") ?? "");
  const note = String(formData.get("note") ?? "").slice(0, 200);
  if (!sellerId) redirect("/admin/sellers?error=BAD_INPUT");
  if (!(ALLOWED_VERIFICATION as readonly string[]).includes(rawTo)) {
    redirect("/admin/sellers?error=BAD_INPUT");
  }
  const to = rawTo as VerificationTarget;

  const res = await setSellerVerificationStatus({ sellerId, to, adminUserId: admin.id, note });
  if (!res.ok) {
    redirect(`/admin/sellers?error=${encodeURIComponent(res.reason)}`);
  }
  revalidatePath("/admin/sellers");
  revalidatePath("/admin");
  redirect("/admin/sellers");
}
