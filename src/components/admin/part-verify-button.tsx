"use client";

import { useState, useTransition } from "react";
import { verifyPartAction } from "@/app/admin/imports/import-actions";

/**
 * P2-F.1 (§4) + P2-I (I4): the human verification act for real catalog records.
 * Only rendered for admins on records that are not yet VERIFIED/DEMO.
 * Evidence URL is mandatory (server re-validates authority AND evidence).
 */
export function PartVerifyButton({ partId, dataStatus }: { partId: string; dataStatus: string }) {
  const [pending, startTransition] = useTransition();
  const [evidence, setEvidence] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  if (dataStatus === "VERIFIED" || dataStatus === "DEMO") return null;

  const verify = () => {
    if (!evidence.trim()) {
      setMsg("نشانی منبع الزامی است");
      return;
    }
    startTransition(async () => {
      const r = await verifyPartAction(partId, evidence.trim());
      setMsg(r.ok ? "تأیید شد" : r.error);
    });
  };

  return (
    <span className="flex flex-wrap items-center gap-1">
      <input
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        placeholder="نشانی منبع شواهد"
        dir="ltr"
        className="input !py-1 !text-xs max-w-[220px]"
        aria-label="نشانی منبع شواهد"
      />
      <button onClick={verify} disabled={pending} className="btn-ghost !px-2 !py-1 !text-xs text-green-700">
        {pending ? "…" : "تأیید داده"}
      </button>
      {msg && <span className="text-[10px] text-black/50">{msg}</span>}
    </span>
  );
}
