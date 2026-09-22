"use client";

import { useTransition } from "react";
import { updateFitmentStatusAction } from "@/app/admin-actions";

const OPTIONS = ["CONFIRMED", "PARTIAL", "PENDING_REVIEW", "REJECTED"] as const;

export function FitmentStatusSelect({ fitmentId, current }: { fitmentId: string; current: string }) {
  const [pending, start] = useTransition();
  return (
    <select
      className="input !w-36 !py-1 text-xs"
      defaultValue={current}
      disabled={pending}
      onChange={(e) => {
        const v = e.target.value as (typeof OPTIONS)[number];
        start(async () => { await updateFitmentStatusAction(fitmentId, v); });
      }}
    >
      {OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
