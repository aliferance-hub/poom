import { NextRequest, NextResponse } from "next/server";
import { getSessionId } from "@/lib/session";
import { createSavedVehicle, activateSavedVehicle } from "@/lib/vehicle";
import { safeBack } from "@/app/api/garage/route-handlers";

/**
 * Garage form endpoint (server-validated; session cookie is the owner key).
 * Same rules as the server actions — no client trust. Redirect-based so it
 * works from plain <form method="post"> without JS.
 */
export async function POST(req: NextRequest) {
  const sid = await getSessionId();
  // P2-H (H17): malformed bodies must not surface as 500s — the form contract
  // reports failures through the ?error= redirect parameter.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    const back = new URL(safeBack(req), req.nextUrl);
    back.searchParams.set("error", "INVALID");
    return NextResponse.redirect(back, { status: 303 });
  }
  const variantId = String(form.get("variantId") ?? "");
  const yearRaw = String(form.get("year") ?? "");
  const nicknameRaw = String(form.get("nickname") ?? "").trim();
  const year = yearRaw === "" ? null : Number(yearRaw);

  const back = new URL(safeBack(req), req.nextUrl);
  if (!variantId || Number.isNaN(Number(yearRaw)) === true && yearRaw !== "") {
    back.searchParams.set("error", "INVALID");
    return NextResponse.redirect(back, { status: 303 });
  }
  let created: Awaited<ReturnType<typeof createSavedVehicle>>;
  try {
    created = await createSavedVehicle(sid, {
      variantId,
      year: year != null && Number.isInteger(year) ? year : null,
      nickname: nicknameRaw || null,
    });
  } catch {
    // Unknown variantId (FK violation) or malformed year — deterministic failure.
    back.searchParams.set("error", "INVALID");
    return NextResponse.redirect(back, { status: 303 });
  }
  if (created.ok) {
    if (form.get("activate") === "1") {
      const act = await activateSavedVehicle(sid, created.id);
      if (!act.ok) back.searchParams.set("error", act.error);
    }
  } else {
    back.searchParams.set("error", created.error);
  }
  return NextResponse.redirect(back, { status: 303 });
}
