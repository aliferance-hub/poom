"use client";

import { useTransition } from "react";
import { prismaTogglePartActive } from "@/app/admin/parts/actions";

export function PartActiveToggle({ partId, active }: { partId: string; active: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button
      className={`badge ${active ? "bg-green-100 text-green-800" : "bg-black/6 text-black/50"}`}
      disabled={pending}
      onClick={() => start(async () => { await prismaTogglePartActive(partId, !active); })}
    >
      {active ? "فعال" : "غیرفعال"}
    </button>
  );
}
