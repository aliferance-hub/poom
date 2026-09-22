"use client";

import { useState, useTransition } from "react";
import { verifyPartAction } from "@/app/admin/imports/import-actions";

/**
 * P2-F.1 (§4): the human verification act for real catalog records.
 * Only rendered for admins on records that are not yet VERIFIED.
 * The action re-validates admin authority server-side on every call.
 */
export function PartVerifyButton({ partId, dataStatus }: { partId: string; dataStatus: string }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (dataStatus === "VERIFIED" || dataStatus === "DEMO") return null;

  const verify = () => {
    startTransition(async () => {
      const r = await verifyPartAction(partId);
      setMsg(r.ok ? "تأیید شد" : r.error);
    });
  };

  return (
    <span className="flex items-center gap-1">
      <button onClick={verify} disabled={pending} className="btn-ghost !px-2 !py-1 !text-xs text-green-700">
        {pending ? "…" : "تأیید داده"}
      </button>
      {msg && <span className="text-[10px] text-black/50">{msg}</span>}
    </span>
  );
}
