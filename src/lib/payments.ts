// Payment abstraction v2 (P2-E §23, §55–56): UI/server code never talks to a
// gateway directly. Canonical money unit: integer IRR. Gateway-unit conversion
// happens INSIDE adapters only. Attempts are an immutable ledger — retries
// create NEW rows; old attempts are never mutated into success.

import { randomBytes } from "node:crypto";

export type CreatePaymentResult = { paymentId: string; authority: string; redirectUrl: string };
export type VerifyResult = { ok: boolean; providerRef?: string; reason?: string };

export interface PaymentService {
  readonly provider: string;
  /** Initiate a payment attempt for a Payment row; returns an authority/opaque token. */
  createPayment(input: { orderId: string; orderNumber: string; amountIRR: number }): Promise<CreatePaymentResult>;
  /** Verify a payment by authority (mock: instantly succeeds or fails). */
  verifyPayment(input: { authority: string; outcome: "success" | "failure" }): Promise<VerifyResult>;
  getPaymentStatus(authority: string): Promise<"PENDING" | "SUCCEEDED" | "FAILED">;
}

/** §55 placeholder: a real provider implements this; config arrives with credentials. */
export interface RealPaymentProviderConfig {
  gateway: string; // e.g. "zarinpal" | "mellat" — configured, never hard-coded here
  credentials: Record<string, string>; // injected via env at deploy time; NEVER committed
  callbackBaseUrl: string;
}
export type RealPaymentAdapter = PaymentService & {
  configure(config: RealPaymentProviderConfig): void;
};

/** Attempt-count + key helpers (idempotencyKey is stable per payment row). */
export async function nextAttemptNumber(prisma: typeof import("@/lib/prisma")["prisma"], paymentId: string): Promise<number> {
  const last = await prisma.paymentAttempt.findFirst({
    where: { paymentId },
    orderBy: { attemptNumber: "desc" },
    select: { attemptNumber: true },
  });
  return (last?.attemptNumber ?? 0) + 1;
}

export function newIdempotencyKey(scope: string): string {
  return `${scope}-${randomBytes(12).toString("base64url")}`;
}

/** In-repo mock adapter for development/MVP. No network, no real money. */
export class MockPaymentAdapter implements PaymentService {
  readonly provider = "mock";

  async createPayment(input: { orderId: string; orderNumber: string; amountIRR: number }): Promise<CreatePaymentResult> {
    const { prisma } = await import("@/lib/prisma");
    const authority = `MOCK-${input.orderNumber}-${randomBytes(4).toString("hex")}`;
    await prisma.payment.create({
      data: { orderId: input.orderId, provider: this.provider, amount: input.amountIRR, status: "PENDING", authority },
    });
    return { paymentId: authority, authority, redirectUrl: `/checkout/mock-pay?authority=${authority}` };
  }

  async getPaymentStatus(authority: string): Promise<"PENDING" | "SUCCEEDED" | "FAILED"> {
    const { prisma } = await import("@/lib/prisma");
    const payment = await prisma.payment.findUnique({ where: { authority } });
    return payment?.status ?? "PENDING";
  }

  async verifyPayment(input: { authority: string; outcome: "success" | "failure" }): Promise<VerifyResult> {
    const { prisma } = await import("@/lib/prisma");
    const payment = await prisma.payment.findUnique({ where: { authority: input.authority } });
    if (!payment) return { ok: false, reason: "PAYMENT_NOT_FOUND" };
    // §26 replay semantics: a success callback for an ALREADY-SUCCEEDED payment
    // verifies ok (the commerce layer short-circuits without re-settling); only a
    // genuinely different outcome (e.g. failure after success) is a conflict.
    if (payment.status === "SUCCEEDED" && input.outcome === "success") {
      return { ok: true, providerRef: "REPLAY" };
    }
    if (payment.status !== "PENDING") return { ok: false, reason: `ALREADY_${payment.status}` };
    // NOTE: settlement (stock decrement, order status) is applied by the commerce
    // state machine in checkout.ts — the adapter only records the gateway outcome.
    return { ok: input.outcome === "success", providerRef: `MOCKREF-${Date.now().toString(36)}` };
  }
}

let cached: PaymentService | undefined;
export function paymentService(): PaymentService {
  cached ??= new MockPaymentAdapter();
  return cached;
}
