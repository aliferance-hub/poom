import { prisma } from "@/lib/prisma";

/**
 * P2-C analytics — coarse funnel events only. NEVER blocks or fails a user
 * flow: logging errors are swallowed by design (observability, not correctness).
 * No PII: sessionId is a random cookie id; query is user-typed search text.
 */
export type SearchEventType =
  | "search_started"
  | "search_submitted"
  | "search_result_clicked"
  | "search_filter_changed"
  | "search_compatible_only_enabled"
  | "vehicle_selector_opened"
  | "vehicle_selected"
  | "vehicle_saved"
  | "vehicle_activated"
  | "vehicle_removed"
  | "garage_opened"
  | "garage_vehicle_opened";

export async function logEvent(
  sessionId: string,
  type: SearchEventType,
  data: { query?: string; resultCount?: number; vehicleId?: string } = {},
): Promise<void> {
  try {
    await prisma.searchEvent.create({
      data: {
        sessionId,
        type,
        query: data.query ?? null,
        resultCount: data.resultCount ?? null,
        vehicleId: data.vehicleId ?? null,
      },
    });
  } catch {
    // swallow — analytics must never break the request
  }
}
