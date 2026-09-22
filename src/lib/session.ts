import { cookies } from "next/headers";
import { newSessionId } from "@/lib/persian";

const COOKIE = "poom_sid";

export async function getSessionId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(COOKIE)?.value;
  if (existing) return existing;
  const sid = newSessionId();
  try {
    store.set(COOKIE, sid, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  } catch {
    // Server Component render — cookie will be set by middleware on next request.
  }
  return sid;
}
