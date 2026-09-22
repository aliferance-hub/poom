"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertDemoTrust } from "@/lib/demo-trust";

/**
 * P2-B fitment mutations — admin-only (demo trust boundary until real auth lands).
 * Sellers and customers have NO server action that can touch Fitment.
 */

const fitmentInput = z
  .object({
    partId: z.string().min(1),
    vehicleId: z.string().min(1),
    variantId: z.string().nullable().optional(),
    engine: z.string().max(60).nullable().optional(),
    transmission: z.string().max(60).nullable().optional(),
    bodyType: z.string().max(40).nullable().optional(),
    // Schema uses Gregorian production years (2002–2015 in demo); accept both ranges
    // so a future Persian-calendar year (e.g. 1395) is never silently misread.
    yearFrom: z.number().int().min(1300).max(2100).nullable().optional(),
    yearTo: z.number().int().min(1300).max(2100).nullable().optional(),
    fitmentStatus: z.enum(["CONFIRMED", "PARTIAL", "REJECTED", "PENDING_REVIEW"]),
    fitmentNote: z.string().max(300).nullable().optional(),
  })
  .refine((d) => d.yearFrom == null || d.yearTo == null || d.yearFrom <= d.yearTo, {
    message: "YEAR_RANGE_INVALID: yearFrom must be <= yearTo",
    path: ["yearFrom"],
  });

export type FitmentInput = z.infer<typeof fitmentInput>;

async function assertRelationsValid(input: FitmentInput) {
  const part = await prisma.part.findUnique({ where: { id: input.partId }, select: { id: true } });
  if (!part) throw new Error("PART_NOT_FOUND");
  const vehicle = await prisma.vehicle.findUnique({ where: { id: input.vehicleId }, select: { id: true } });
  if (!vehicle) throw new Error("VEHICLE_NOT_FOUND");
  if (input.variantId) {
    const variant = await prisma.vehicleVariant.findUnique({ where: { id: input.variantId }, select: { id: true, vehicleId: true } });
    if (!variant) throw new Error("VARIANT_NOT_FOUND");
    if (variant.vehicleId !== input.vehicleId) throw new Error("VARIANT_NOT_IN_VEHICLE");
  }
}

/** revalidatePath needs a request/render context; outside one (tests, cron) it
 *  throws. A cache-revalidation hiccup must never fail a completed mutation. */
function safeRevalidate(path: string) {
  try {
    revalidatePath(path);
  } catch {
    // no request scope — nothing to revalidate
  }
}

export async function createFitmentAction(raw: unknown) {
  await assertDemoTrust();
  const parsed = fitmentInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("؛ ") };
  }
  const input = parsed.data;
  try {
    await assertRelationsValid(input);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "RELATION_INVALID" };
  }

  const dims = {
    partId: input.partId,
    vehicleId: input.vehicleId,
    variantId: input.variantId ?? null,
    engine: input.engine ?? null,
    transmission: input.transmission ?? null,
    bodyType: input.bodyType ?? null,
    yearFrom: input.yearFrom ?? null,
    yearTo: input.yearTo ?? null,
  };

  try {
    // Dimensions-guard (@@unique NULLS NOT DISTINCT, migration 20260914_p2b_catalog_fitment)
    // is the DB backstop: create may P2002 → update the winner instead.
    const existing = await prisma.fitment.findFirst({ where: dims });
    const fitment = existing
      ? await prisma.fitment.update({ where: { id: existing.id }, data: { fitmentStatus: input.fitmentStatus, fitmentNote: input.fitmentNote ?? null } })
      : await prisma.fitment.create({ data: { ...dims, fitmentStatus: input.fitmentStatus, fitmentNote: input.fitmentNote ?? null } })
          .catch(async (e: { code?: string }) => {
            if (e.code !== "P2002") throw e;
            const winner = await prisma.fitment.findFirstOrThrow({ where: dims });
            return prisma.fitment.update({ where: { id: winner.id }, data: { fitmentStatus: input.fitmentStatus, fitmentNote: input.fitmentNote ?? null } });
          });
    safeRevalidate("/admin/fitment");
    return { ok: true as const, id: fitment.id };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "FITMENT_WRITE_FAILED" };
  }
}

export async function updateFitmentAction(id: string, raw: unknown) {
  await assertDemoTrust();
  const parsed = fitmentInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("؛ ") };
  }
  const input = parsed.data;
  try {
    await assertRelationsValid(input);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "RELATION_INVALID" };
  }
  try {
    await prisma.fitment.update({
      where: { id },
      data: {
        vehicleId: input.vehicleId,
        variantId: input.variantId ?? null,
        engine: input.engine ?? null,
        transmission: input.transmission ?? null,
        bodyType: input.bodyType ?? null,
        yearFrom: input.yearFrom ?? null,
        yearTo: input.yearTo ?? null,
        fitmentStatus: input.fitmentStatus,
        fitmentNote: input.fitmentNote ?? null,
      },
    });
    safeRevalidate("/admin/fitment");
    return { ok: true as const };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return { ok: false as const, error: "CONFLICT: ردیف دیگری با همین ابعاد وجود دارد" };
    }
    return { ok: false as const, error: e instanceof Error ? e.message : "FITMENT_WRITE_FAILED" };
  }
}

export async function deleteFitmentAction(id: string) {
  await assertDemoTrust();
  await prisma.fitment.delete({ where: { id } });
  safeRevalidate("/admin/fitment");
  return { ok: true as const };
}

export async function setFitmentStatusAction(id: string, status: "CONFIRMED" | "PARTIAL" | "REJECTED" | "PENDING_REVIEW") {
  await assertDemoTrust();
  await prisma.fitment.update({ where: { id }, data: { fitmentStatus: status } });
  safeRevalidate("/admin/fitment");
  return { ok: true as const };
}
