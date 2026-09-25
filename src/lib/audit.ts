import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { logSellerEventTx } from "@/lib/seller/seller-audit";

/**
 * ───────────────────── Audit 2.0 (P2-E §43, §73) ─────────────────────
 * SellerEventLog is promoted to the general audit store: same transactional
 * guarantees, broader entity vocabulary (auth/payment/order/return/governance).
 * `sellerId` stays NOT NULL, so non-seller events use the acting user id in
 * sellerId? No — they key on actor + entity and carry sellerId only when a
 * seller is the subject. For system/customer actors a stable sentinel row is
 * NOT created; instead non-seller events are recorded with sellerId = the
 * acting user id and entity namespaced (e.g. "auth:User"), keeping the single
 * table simple while remaining filterable. Secrets are never recorded.
 */
export type AuditEvent =
  | "user_login"
  | "user_login_failed"
  | "user_logout"
  | "session_revoked"
  | "seller_approved"
  | "seller_suspended"
  | "seller_rejected"
  | "seller_reactivated"
  | "seller_verification_changed" // P2-G.1: admin verification decision (origin-independent axis)
  | "seller_order_status_changed"
  | "order_created"
  | "payment_attempt_created"
  | "payment_verified"
  | "payment_verification_failed"
  | "settlement_started"
  | "settlement_completed"
  | "settlement_failed"
  | "return_created"
  | "return_state_changed"
  | "refund_state_changed"
  | "seller_offer_price_updated"
  | "seller_offer_stock_updated"
  | "seller_offer_sku_updated"
  | "seller_offer_shipping_updated"
  | "seller_offer_status_changed"
  | "seller_inventory_csv_import_started"
  | "seller_inventory_csv_imported"
  | "seller_inventory_csv_rejected"
  | "seller_profile_updated"
  | "customer_order_cancelled";

type AuditInput = {
  actor: string; // userId or "system" / "guest:<sid>"
  event: AuditEvent;
  entity: string; // "Offer" | "SellerOrder" | "Payment" | "Session" | ...
  entityId?: string;
  sellerId?: string; // set when a seller is the subject of the event
  meta?: Record<string, unknown>;
};

const SYSTEM_SELLER_ID = "audit-system";

/**
 * The SellerEventLog store requires a sellerId FK (NOT NULL). Non-seller events
 * (auth/payments/system) reference a stable sentinel Seller row created once.
 * Real seller events always use the actual sellerId.
 */
async function ensureSystemSellerTx(tx: Prisma.TransactionClient): Promise<string> {
  const existing = await tx.seller.findUnique({ where: { id: SYSTEM_SELLER_ID }, select: { id: true } });
  if (existing) return existing.id;
  await tx.seller.create({
    data: {
      id: SYSTEM_SELLER_ID, businessName: "سیستم (رخدادهای سیستمی)", sellerStatus: "PENDING", status: "SYSTEM", verified: false,
      // P2-G.1: the bookkeeping sentinel is neither DEMO data nor a real seller.
      sellerOrigin: "SYSTEM", sellerVerificationStatus: "UNVERIFIED",
    },
  });
  return SYSTEM_SELLER_ID;
}

export async function logAuditTx(tx: Prisma.TransactionClient, input: AuditInput): Promise<void> {
  const sellerId = input.sellerId ?? (await ensureSystemSellerTx(tx));
  await logSellerEventTx(tx, {
    sellerId,
    actor: input.actor,
    event: input.event as never,
    entity: input.entity as never,
    entityId: input.entityId,
    meta: input.meta,
  });
}

export async function logAudit(input: AuditInput): Promise<void> {
  await logAuditTx(prisma as unknown as Prisma.TransactionClient, input);
}

// ───────────────── Order state machines (P2-E §21–22) ─────────────────

export const ORDER_TRANSITIONS: Record<string, string[]> = {
  PENDING_PAYMENT: ["PAID", "CANCELLED"],
  PAID: ["FULFILLED", "CANCELLED"], // CANCELLED post-payment = pre-shipment only, via service checks
  FULFILLED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransitionOrder(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

/** Seller-facing workflow (DB enum values only; P2-D map hardened). */
export const SELLER_ORDER_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "RETURNED"],
  DELIVERED: [],
  CANCELLED: [],
  RETURNED: [],
};

export function canTransitionSellerOrder(from: string, to: string): boolean {
  return (SELLER_ORDER_TRANSITIONS[from] ?? []).includes(to);
}

/** Seller governance transitions (§18–19). */
export const SELLER_GOVERNANCE_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["ACTIVE", "REJECTED"],
  ACTIVE: ["SUSPENDED"],
  SUSPENDED: ["ACTIVE", "REJECTED"], // reactivate or reject
  REJECTED: [], // terminal (a fresh application is a new record)
};

export function canTransitionSellerStatus(from: string, to: string): boolean {
  return (SELLER_GOVERNANCE_TRANSITIONS[from] ?? []).includes(to);
}
