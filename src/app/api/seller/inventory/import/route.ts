import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import {
  parseSellerInventoryCsv,
  previewSellerInventoryImport,
  commitSellerInventoryImport,
  CSV_LIMITS,
  type PreviewRow,
} from "@/lib/seller/seller-csv";
import { logSellerEvent } from "@/lib/seller/seller-audit";

/**
 * CSV import endpoints (server-validated, session-owned).
 *   POST { csvText } → parse + validate + DB-backed preview (NO writes)
 *   PUT  { csvText } → all-or-nothing commit of VALID rows only
 * File content is untrusted input: size/row/field limits enforced in the parser.
 */

function tooLargeGuard(text: string): boolean {
  return text.length > CSV_LIMITS.maxFileBytes;
}

export async function POST(req: NextRequest) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return NextResponse.json({ error: "دسترسی فروشنده یافت نشد." }, { status: 404 });

  const body = await req.json().catch(() => null);
  const csvText = String(body?.csvText ?? "");
  if (!csvText.trim()) return NextResponse.json({ fatal: "فایل خالی است." }, { status: 400 });
  if (tooLargeGuard(csvText)) {
    await logSellerEvent({
      sellerId: identity.seller.id, actor: identity.userId,
      event: "seller_inventory_csv_rejected", entity: "CsvImport", meta: { reason: "TOO_LARGE" },
    });
    return NextResponse.json({ fatal: "حجم فایل بیش از حد مجاز است (حداکثر ۲ مگابایت)." }, { status: 413 });
  }

  const parsed = parseSellerInventoryCsv(csvText);
  if (!parsed.ok) {
    await logSellerEvent({
      sellerId: identity.seller.id, actor: identity.userId,
      event: "seller_inventory_csv_rejected", entity: "CsvImport", meta: { reason: "PARSE", fatal: parsed.fatal },
    });
    return NextResponse.json({ fatal: parsed.fatal }, { status: 400 });
  }

  const { preview, validCount, invalidCount } = await previewSellerInventoryImport(identity.seller.id, parsed);
  return NextResponse.json({
    preview: preview.map((r: PreviewRow) => ({
      rowNumber: r.rowNumber,
      status: r.status,
      partTitle: r.partTitle,
      sellerSku: r.data?.seller_sku,
      price: r.data?.price_irr,
      stock: r.data?.stock,
      active: r.data?.active,
      error: r.error,
    })),
    validCount,
    invalidCount,
  });
}

export async function PUT(req: NextRequest) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return NextResponse.json({ error: "دسترسی فروشنده یافت نشد." }, { status: 404 });

  const body = await req.json().catch(() => null);
  const csvText = String(body?.csvText ?? "");
  if (!csvText.trim() || tooLargeGuard(csvText)) {
    return NextResponse.json({ fatal: "فایل نامعتبر است." }, { status: 400 });
  }

  await logSellerEvent({
    sellerId: identity.seller.id, actor: identity.userId,
    event: "seller_inventory_csv_import_started", entity: "CsvImport",
  });

  const parsed = parseSellerInventoryCsv(csvText);
  if (!parsed.ok) return NextResponse.json({ fatal: parsed.fatal }, { status: 400 });
  const { preview, validCount, invalidCount } = await previewSellerInventoryImport(identity.seller.id, parsed);

  const res = await commitSellerInventoryImport(identity.seller.id, identity.userId, preview);
  if (!res.ok) {
    await logSellerEvent({
      sellerId: identity.seller.id, actor: identity.userId,
      event: "seller_inventory_csv_rejected", entity: "CsvImport", meta: { reason: res.reason },
    });
    return NextResponse.json(res, { status: 422 });
  }
  return NextResponse.json({ ...res, validCount, invalidCount });
}
