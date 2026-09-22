"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/identity";
import { prisma } from "@/lib/prisma";
import {
  ingestRawCsv, normalizeBatch, validateBatch, approveBatch, commitBatch, verifyRealPart,
} from "@/lib/catalog-import";

async function adminId(): Promise<string> {
  const a = await requireAdmin();
  if (!a) throw new Error("AUTH_REQUIRED: admin session required");
  return a.id;
}

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : "UNKNOWN" };
}

export async function ingestCsvAction(formData: FormData): Promise<{ ok: true; batchId: string; rowCount: number } | { ok: false; error: string }> {
  try {
    const uid = await adminId();
    const label = String(formData.get("label") ?? "").trim();
    const sourceRef = String(formData.get("sourceRef") ?? "").trim();
    const sourceUrl = String(formData.get("sourceUrl") ?? "").trim() || undefined;
    const sourceUpdatedAtRaw = String(formData.get("sourceUpdatedAt") ?? "").trim();
    const csv = String(formData.get("csv") ?? "");
    if (!label || !sourceRef) return fail(new Error("LABEL_AND_SOURCE_REF_REQUIRED"));
    if (!csv.trim()) return fail(new Error("EMPTY_CSV"));
    // P2-F.1 (§2): the provenance gate requires sourceUpdatedAt — collect it in the form.
    const sourceUpdatedAt = sourceUpdatedAtRaw ? new Date(sourceUpdatedAtRaw) : undefined;
    if (sourceUpdatedAtRaw && (!sourceUpdatedAt || isNaN(sourceUpdatedAt.getTime()))) {
      return fail(new Error("BAD_SOURCE_UPDATED_AT"));
    }
    const r = await ingestRawCsv({ label, sourceRef, sourceUrl, sourceUpdatedAt, createdBy: uid }, csv);
    revalidatePath("/admin/imports");
    return { ok: true, ...r };
  } catch (e) {
    return fail(e);
  }
}

export async function normalizeBatchAction(batchId: string) {
  try {
    await adminId();
    const r = await normalizeBatch(batchId);
    revalidatePath(`/admin/imports/${batchId}`);
    return { ok: true as const, ...r };
  } catch (e) {
    return fail(e);
  }
}

export async function validateBatchAction(batchId: string) {
  try {
    await adminId();
    const r = await validateBatch(batchId);
    revalidatePath(`/admin/imports/${batchId}`);
    return { ok: true as const, ...r };
  } catch (e) {
    return fail(e);
  }
}

export async function approveBatchAction(batchId: string) {
  try {
    const uid = await adminId();
    const r = await approveBatch(batchId, uid);
    revalidatePath(`/admin/imports/${batchId}`);
    return { ok: true as const, ...r };
  } catch (e) {
    return fail(e);
  }
}

export async function commitBatchAction(batchId: string) {
  try {
    await adminId();
    const r = await commitBatch(batchId);
    revalidatePath(`/admin/imports/${batchId}`);
    return { ok: true as const, ...r };
  } catch (e) {
    return fail(e);
  }
}

/** F8/P2-F.1 §4: a human verifies a part — delegates to the lib gate (audited, refuses DEPRECATED). */
export async function verifyPartAction(partId: string, sourceUrl?: string) {
  try {
    const uid = await adminId();
    const r = await verifyRealPart(partId, uid, sourceUrl);
    if (!r.ok) return fail(new Error(r.reason));
    revalidatePath("/admin/parts");
    revalidatePath("/admin/data-quality");
    revalidatePath(`/parts/${r.slug}`);
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

/** F8: withdraw a part from new storefront surfaces (existing offers untouched). */
export async function deprecatePartAction(partId: string, note?: string) {
  try {
    const uid = await adminId();
    await prisma.part.update({
      where: { id: partId },
      data: {
        dataStatus: "DEPRECATED",
        dataNotes: note,
        verifiedAt: null,
        verifiedBy: null,
        dataVersion: { increment: 1 },
      },
    });
    revalidatePath("/admin/parts");
    revalidatePath("/admin/data-quality");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}
