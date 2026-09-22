"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";
import { transitionSellerStatus } from "@/lib/governance";
import type { SellerStatus } from "@prisma/client";

const ALLOWED: SellerStatus[] = ["ACTIVE", "SUSPENDED", "REJECTED", "PENDING"];

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
