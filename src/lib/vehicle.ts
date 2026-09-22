import { prisma } from "@/lib/prisma";
import { toPersianDigits } from "@/lib/persian";
import type { VehicleContext } from "@/lib/fitment";
import { Prisma } from "@prisma/client";

/**
 * ───────────────────────── Vehicle Context & Garage (P2-C) ─────────────────────────
 * ONE shared VehicleContext shape (re-exported from the Fitment Engine) feeds
 * fitment, search, part pages, garage and the 3D flow. resolveVehicleContext
 * fills every field the database actually has — it NEVER invents data.
 */

export type { VehicleContext } from "@/lib/fitment";

export type ResolvedVehicleContext = VehicleContext & {
  vehicleLabel: string; // "پژو 206"
  variantLabel: string | null; // "تیپ 5"
  engineLabel: string | null;
  transmissionLabel: string | null;
};

/** Resolve the full configuration for a variant. Unknown fields stay missing. */
export async function resolveVehicleContext(
  variantId: string,
  year?: number | null,
): Promise<ResolvedVehicleContext | null> {
  const variant = await prisma.vehicleVariant.findUnique({
    where: { id: variantId },
    select: {
      id: true,
      vehicleId: true,
      trim: true,
      engineId: true,
      transmissionId: true,
      engineRef: { select: { id: true, name: true } },
      transmissionRef: { select: { id: true, name: true } },
      vehicle: { select: { id: true, displayName: true, bodyType: true } },
    },
  });
  if (!variant) return null;
  return {
    vehicleId: variant.vehicleId,
    variantId: variant.id,
    engineId: variant.engineId,
    transmissionId: variant.transmissionId,
    // Constraint matching in the Fitment Engine is text-based (P2-B rules carry
    // free-text engine/transmission); the entity name IS that text in demo data.
    engine: variant.engineRef?.name ?? null,
    transmission: variant.transmissionRef?.name ?? null,
    bodyType: variant.vehicle.bodyType ?? null,
    year: year ?? null,
    vehicleLabel: variant.vehicle.displayName,
    variantLabel: variant.trim,
    engineLabel: variant.engineRef?.name ?? null,
    transmissionLabel: variant.transmissionRef?.name ?? null,
  };
}

/** Label for a context without a DB round-trip (already resolved contexts). */
export function vehicleContextLabel(ctx: ResolvedVehicleContext | null): string {
  if (!ctx) return "";
  return [ctx.vehicleLabel, ctx.variantLabel, ctx.year != null ? toPersianDigits(ctx.year) : null]
    .filter(Boolean)
    .join(" ");
}

// ── Garage concurrency primitives ─────────────────────────────────────
// The invariant "at most one active vehicle per session" is enforced by TWO
// layers (see PHASE2-C-GARAGE.md §Concurrency):
//   1. DB:  partial unique index `GarageVehicle_one_active_per_session`
//           (UNIQUE ("sessionId") WHERE "isActive") — the backstop.
//   2. Tx:  a session-scoped advisory lock taken BEFORE any row access, so
//           concurrent mutations of ONE session's garage serialize locally.
//           Other sessions' garages are never blocked (no global lock).
//           READ COMMITTED isolation: per-statement fresh snapshots mean no
//           stale-read conflicts between serialized writers (SERIALIZABLE
//           froze the waiter's snapshot at the lock SELECT and caused P2034
//           retry storms under contention).
// Concurrent activate(A) + activate(B): the loser waits on the lock, then runs
// its writes against committed state — it can never interleave two active rows
// past the unique index.

const GARAGE_LOCK_PREFIX = "poom_garage:";
const GARAGE_TX_RETRIES = 5;

function garageLockKey(sessionId: string): string {
  return `${GARAGE_LOCK_PREFIX}${sessionId}`;
}

/** Take the per-session garage advisory lock INSIDE the given transaction. */
async function lockGarage(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  // hashtext(text) is evaluated SERVER-SIDE over the bind param → int4 →
  // pg_advisory_xact_lock(int). Binding the expression itself as text fails
  // (22P02, no text overload of the lock fn). Prisma additionally cannot
  // deserialize the lock fn's `void` return column, so the call is coerced to
  // a boolean expression — the canonical Prisma advisory-lock workaround.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${garageLockKey(sessionId)})) IS NULL AS locked`;
}

/** True for transient failures that a fresh transaction may survive. */
function isRetryableTxError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") return true; // txn conflict/serialization
  const pgCode = (e as { code?: string })?.code;
  return pgCode === "40001" || pgCode === "40P01"; // serialization_failure / deadlock_detected
}

/**
 * Run `fn` in a transaction guarded by the session garage lock, retrying
 * transient conflicts (40001/P2034/40P01) with the lock re-acquired each try.
 */
async function withGarageLock<T>(
  sessionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GARAGE_TX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await lockGarage(tx, sessionId); // FIRST statement — before any row access
        return fn(tx);
      }, opts);
    } catch (e) {
      lastError = e;
      if (!isRetryableTxError(e) || attempt === GARAGE_TX_RETRIES) break;
    }
  }
  throw lastError;
}

// ─────────────────────────────── Garage ───────────────────────────────

export type GarageVehicleView = {
  id: string;
  nickname: string | null;
  year: number | null;
  isActive: boolean;
  variantId: string;
  vehicleLabel: string;
  variantLabel: string;
  engineLabel: string | null;
  transmissionLabel: string | null;
  bodyType: string | null;
};

export async function getMyVehicles(sessionId: string): Promise<GarageVehicleView[]> {
  const rows = await prisma.garageVehicle.findMany({
    where: { sessionId },
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      nickname: true,
      year: true,
      isActive: true,
      variantId: true,
      variant: {
        select: {
          trim: true,
          engineRef: { select: { name: true } },
          transmissionRef: { select: { name: true } },
          vehicle: { select: { displayName: true, bodyType: true } },
        },
      },
    },
  });
  return rows.map((g) => ({
    id: g.id,
    nickname: g.nickname,
    year: g.year,
    isActive: g.isActive,
    variantId: g.variantId,
    vehicleLabel: g.variant.vehicle.displayName,
    variantLabel: g.variant.trim,
    engineLabel: g.variant.engineRef?.name ?? null,
    transmissionLabel: g.variant.transmissionRef?.name ?? null,
    bodyType: g.variant.vehicle.bodyType ?? null,
  }));
}

/** The single active vehicle context for this session (guest or customer). */
export async function getActiveVehicleContext(sessionId: string): Promise<ResolvedVehicleContext | null> {
  const active = await prisma.garageVehicle.findFirst({
    where: { sessionId, isActive: true },
    select: { variantId: true, year: true },
  });
  if (!active) return null;
  return resolveVehicleContext(active.variantId, active.year);
}

export type GarageActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Add a vehicle to the garage. First vehicle becomes active automatically;
 * otherwise it is added inactive. Duplicate (same variant+year+nickname-null)
 * is prevented per session.
 *
 * Concurrency: the count-based "first vehicle becomes active" decision runs
 * under the session garage lock — two concurrent first-adds cannot both see
 * count 0; the loser either lands inactive or hits the partial unique index
 * (surfaced as CONFLICT, never a silent 2-active state).
 */
export async function createSavedVehicle(
  sessionId: string,
  input: { variantId: string; year?: number | null; nickname?: string | null },
): Promise<GarageActionResult> {
  const variant = await prisma.vehicleVariant.findUnique({
    where: { id: input.variantId },
    select: { id: true, vehicleId: true },
  });
  if (!variant) return { ok: false, error: "خودروی انتخاب‌شده معتبر نیست." };

  try {
    const created = await withGarageLock(sessionId, async (tx) => {
      const dup = await tx.garageVehicle.findFirst({
        where: { sessionId, variantId: input.variantId, year: input.year ?? null, nickname: input.nickname ?? null },
        select: { id: true },
      });
      if (dup) return dup; // idempotent re-add
      const count = await tx.garageVehicle.count({ where: { sessionId } });
      return tx.garageVehicle.create({
        data: {
          sessionId,
          vehicleId: variant.vehicleId,
          variantId: input.variantId,
          year: input.year ?? null,
          nickname: input.nickname ?? null,
          isActive: count === 0,
        },
      });
    });
    return { ok: true, id: created.id };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "CONFLICT" }; // unique-index backstop tripped
    }
    throw e;
  }
}

/**
 * Exactly one active vehicle per session. Strategy (per PHASE2-C-GARAGE.md):
 * ownership pre-check → transaction { session advisory lock FIRST → deactivate
 * all active → activate target } → retry on transient conflicts. The partial
 * unique index is the final backstop; under the lock it can only trip if data
 * was corrupted beforehand, which we report as CONFLICT.
 *
 * Isolation is deliberately READ COMMITTED (Prisma default): with SERIALIZABLE
 * a waiter's snapshot freezes at the lock SELECT — before the winner commits —
 * so every wake-up carried a stale snapshot and SSI raised P2034 read-write
 * conflicts (10-way contention exhausted 5 retries). Under the advisory lock
 * writers are strictly serialized and READ COMMITTED's per-statement fresh
 * snapshots make conflicts structurally impossible.
 */
export async function activateSavedVehicle(sessionId: string, garageId: string): Promise<GarageActionResult> {
  const owned = await prisma.garageVehicle.findFirst({ where: { id: garageId, sessionId }, select: { id: true } });
  if (!owned) return { ok: false, error: "NOT_OWNER" };
  try {
    await withGarageLock(sessionId, async (tx) => {
      await tx.garageVehicle.updateMany({ where: { sessionId, isActive: true }, data: { isActive: false } });
      await tx.garageVehicle.update({ where: { id: garageId }, data: { isActive: true } });
    });
    return { ok: true, id: garageId };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2025") return { ok: false, error: "NOT_FOUND" }; // deleted mid-flight
      if (e.code === "P2002") return { ok: false, error: "CONFLICT" }; // would create 2nd active — refused
    }
    throw e;
  }
}

export async function updateSavedVehicle(
  sessionId: string,
  garageId: string,
  input: { year?: number | null; nickname?: string | null },
): Promise<GarageActionResult> {
  const owned = await prisma.garageVehicle.findFirst({ where: { id: garageId, sessionId }, select: { id: true } });
  if (!owned) return { ok: false, error: "NOT_OWNER" };
  await prisma.garageVehicle.update({
    where: { id: garageId },
    data: { year: input.year ?? null, nickname: input.nickname ?? null },
  });
  return { ok: true, id: garageId };
}

export async function deleteSavedVehicle(sessionId: string, garageId: string): Promise<GarageActionResult> {
  const owned = await prisma.garageVehicle.findFirst({ where: { id: garageId, sessionId }, select: { id: true } });
  if (!owned) return { ok: false, error: "NOT_OWNER" };
  await prisma.garageVehicle.delete({ where: { id: garageId } });
  return { ok: true, id: garageId };
}
