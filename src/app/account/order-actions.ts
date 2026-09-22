"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionId } from "@/lib/session";
import { getCurrentUser } from "@/lib/auth/identity";
import { logAudit } from "@/lib/audit";

/**
 * §49: customers may cancel ONLY unpaid orders (PENDING_PAYMENT). Paid orders
 * go through the return/refund workflow. Ownership resolved server-side.
 */
export async function cancelCustomerOrder(formData: FormData) {
  const orderId = String(formData.get("orderId") ?? "");
  const sid = await getSessionId();
  const user = await getCurrentUser();
  const actor = user?.id ?? `guest:${sid.slice(-6)}`;

  const order = await prisma.order.findFirst({
    where: { id: orderId, OR: [{ sessionId: sid }, { userId: user?.id }] },
    select: { id: true, status: true, paymentStatus: true },
  });
  if (!order) redirect("/account/orders?error=NOT_FOUND");
  if (order.status !== "PENDING_PAYMENT" || order.paymentStatus === "SUCCEEDED") {
    redirect("/account/orders?error=NOT_CANCELLABLE");
  }

  try {
    await prisma.$transaction(async (tx) => {
      // AUDIT FIX C1 (companion): conditional cancel — only a still-PENDING_PAYMENT
      // order flips. If a gateway callback settled the order between the check
      // above and this write, the cancel becomes a no-op (the customer is routed
      // to the order that is now PAID instead of tearing it down).
      const cancelled = await tx.order.updateMany({
        where: { id: order.id, status: "PENDING_PAYMENT", paymentStatus: { not: "SUCCEEDED" } },
        data: { status: "CANCELLED" },
      });
      if (cancelled.count !== 1) throw new Error("ORDER_NOT_CANCELLABLE");
      await tx.sellerOrder.updateMany({ where: { orderId: order.id, status: "PENDING" }, data: { status: "CANCELLED" } });
    });
  } catch {
    // lost the cancel/settle race → the order is paid; nothing to tear down
    redirect(`/account/orders/${order.id}`);
  }
  await logAudit({ actor, event: "customer_order_cancelled", entity: "Order", entityId: order.id });
  revalidatePath("/account/orders");
  redirect(`/account/orders/${order.id}`);
}
