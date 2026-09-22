import { NextResponse } from "next/server";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { exportSellerInventoryCsv } from "@/lib/seller/seller-csv";

/** GET /api/seller/inventory/export — CSV of ONLY the authenticated seller's rows. */
export async function GET() {
  const identity = await getAuthenticatedSeller();
  if (!identity) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 404 });

  const csv = await exportSellerInventoryCsv(identity.seller.id);
  return new NextResponse("\uFEFF" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="poom-inventory-${identity.seller.id}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
