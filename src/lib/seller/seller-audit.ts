import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/**
 * ───────────────────── Audit + observability (P2-D) ─────────────────────
 * Every seller mutation lands in SellerEventLog inside the SAME transaction
 * as the change it describes. `meta` carries safe identifiers/counts only —
 * never secrets, session keys, or customer payment data (§34).
 */
export type SellerEvent =
  | "seller_offer_price_updated"
  | "seller_offer_stock_updated"
  | "seller_offer_sku_updated"
  | "seller_offer_shipping_updated"
  | "seller_offer_status_changed"
  | "seller_inventory_csv_import_started"
  | "seller_inventory_csv_imported"
  | "seller_inventory_csv_rejected"
  | "seller_order_status_changed"
  | "seller_profile_updated"
  // P2-G: real onboarding + first-party offer creation
  | "seller_onboarding_applied"
  | "seller_offer_created";

type LogInput = {
  sellerId: string;
  actor: string; // userId or "system"
  event: SellerEvent;
  entity: "Offer" | "SellerOrder" | "Seller" | "CsvImport";
  entityId?: string;
  meta?: Record<string, unknown>;
};

/** Log atomically with the mutation: pass a Prisma transaction client. */
export async function logSellerEventTx(tx: Prisma.TransactionClient, input: LogInput): Promise<void> {
  await tx.sellerEventLog.create({
    data: {
      sellerId: input.sellerId,
      actor: input.actor,
      event: input.event,
      entity: input.entity,
      entityId: input.entityId ?? null,
      meta: (input.meta ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

/** Fire-and-forget standalone log (non-transactional context). */
export async function logSellerEvent(input: LogInput): Promise<void> {
  await logSellerEventTx(prisma as unknown as Prisma.TransactionClient, input);
}
