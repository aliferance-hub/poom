import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE = "poom_sid";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  if (!req.cookies.get(COOKIE)?.value) {
    const sid = `s_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    res.cookies.set(COOKIE, sid, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
