import { NextRequest, NextResponse } from "next/server";
import { getSessionId } from "@/lib/session";
import { activateSavedVehicle } from "@/lib/vehicle";
import { safeBack } from "@/app/api/garage/route-handlers";

/**
 * Activate one saved vehicle (exactly-one-active enforced in the service).
 * Service failures redirect back with ?error=… — never silently swallowed.
 */
export async function POST(req: NextRequest) {
  const sid = await getSessionId();
  const form = await req.formData();
  const garageId = String(form.get("garageId") ?? "");
  const back = new URL(safeBack(req), req.nextUrl);
  if (garageId) {
    const r = await activateSavedVehicle(sid, garageId);
    if (!r.ok) {
      back.searchParams.set("error", r.error); // NOT_OWNER | NOT_FOUND | CONFLICT
    }
  }
  return NextResponse.redirect(back, { status: 303 });
}
