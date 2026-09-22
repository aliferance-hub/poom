import { NextRequest, NextResponse } from "next/server";
import { getSearchSuggestions } from "@/lib/search";

/** Autocomplete: grouped suggestions, lightweight (5 parallel indexed queries). */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  try {
    const suggestions = await getSearchSuggestions(q);
    return NextResponse.json(suggestions);
  } catch {
    // Operational failure must not masquerade as "no results" (P2-C §36).
    return NextResponse.json({ error: "SEARCH_UNAVAILABLE" }, { status: 503 });
  }
}
