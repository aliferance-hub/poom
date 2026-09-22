import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, revokeSession } from "@/lib/auth/session";

/** POST /api/seller/logout — revokes the server-side session and clears the cookie. */
export async function POST(req: Request) {
  const store = await cookies();
  await revokeSession(store.get(SESSION_COOKIE)?.value);
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
