// This file is intentionally not a route. Route handlers:
//   poom/src/app/api/garage/add/route.ts
//   poom/src/app/api/garage/activate/route.ts
//   poom/src/app/api/garage/delete/route.ts
// Shared helper lives here (imported by all three) to avoid duplication.
import { NextRequest } from "next/server";

export function safeBack(req: NextRequest): string {
  const raw = req.nextUrl.searchParams.get("back") ?? "/account/garage";
  return /^\/(?!\/)[^\\\s]*$/.test(raw) ? raw : "/account/garage";
}
