"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionId } from "@/lib/session";
import { getCurrentUser } from "@/lib/auth/identity";
import { rateLimiter, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { createReturnRequest } from "@/lib/returns";

/**
 * Customer return submission (P2-E §37, §44, §61): ownership + eligibility are
 * resolved server-side; submission is rate-limited; duplicate requests resolve
 * idempotently to the existing active request.
 */
export async function submitReturnAction(formData: FormData) {
  const orderItemId = String(formData.get("orderItemId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const notes = String(formData.get("notes") ?? "");
  const sid = await getSessionId();
  const user = await getCurrentUser();
  const actor = user?.id ?? `guest:${sid.slice(-6)}`;

  const rl = await rateLimiter.check(`return:${sid}`, RATE_LIMITS.returnSubmit.limit, RATE_LIMITS.returnSubmit.windowMs);
  if (!rl.allowed) redirect(`/account/returns/new?item=${encodeURIComponent(orderItemId)}&error=RATE_LIMITED`);

  const res = await createReturnRequest({ orderItemId, reason, notes, owner: { sessionId: sid, userId: user?.id }, actor });
  if (!res.ok) {
    const err = res.reason === "ELIGIBILITY" ? "ELIGIBILITY" : res.reason === "RATE_LIMITED" ? "RATE_LIMITED" : "INVALID";
    redirect(`/account/returns/new?item=${encodeURIComponent(orderItemId)}&error=${err}`);
  }
  revalidatePath("/account/orders");
  redirect(`/account/orders?return=${encodeURIComponent(res.returnId)}`);
}
