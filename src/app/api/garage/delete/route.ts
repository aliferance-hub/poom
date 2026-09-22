import { NextRequest, NextResponse } from "next/server";
import { getSessionId } from "@/lib/session";
import { deleteSavedVehicle } from "@/lib/vehicle";
import { safeBack } from "@/app/api/garage/route-handlers";

/**
 * Delete one saved vehicle — ownership checked in the service. No session lock
 * needed for the invariant: deletion only moves rows OUT of the active state,
 * so it can never create a second active row (the partial unique index is
 * untouched).
 */
export async function POST(req: NextRequest) {
  const sid = await getSessionId();
  const form = await req.formData();
  const garageId = String(form.get("garageId") ?? "");
  const back = new URL(safeBack(req), req.nextUrl);
  if (garageId) {
    const r = await deleteSavedVehicle(sid, garageId);
    if (!r.ok) back.searchParams.set("error", r.error);
  }
  return NextResponse.redirect(back, { status: 303 });
}
