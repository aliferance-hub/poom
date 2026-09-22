import { NextResponse } from "next/server";
import { getCartView } from "@/lib/cart";
import { getSessionId } from "@/lib/session";

export async function GET() {
  const sid = await getSessionId();
  const view = await getCartView(sid);
  return NextResponse.json({ itemCount: view.itemCount, subtotal: view.subtotal });
}
