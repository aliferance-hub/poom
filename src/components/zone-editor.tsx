"use client";

import { useState, useTransition } from "react";
import { updateZoneAction } from "@/app/admin-actions";

export function ZoneEditor({ zone }: { zone: { id: string; title: string; description: string; vehicle: string; key: string } }) {
  const [title, setTitle] = useState(zone.title);
  const [description, setDescription] = useState(zone.description);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <div className="card flex flex-wrap items-center gap-2 p-3 text-sm">
      <span className="badge bg-black/6 font-mono" dir="ltr">{zone.key}</span>
      <span className="text-xs text-black/45">{zone.vehicle}</span>
      <input value={title} onChange={(e) => setTitle(e.target.value)} className="input !w-40 !py-1" aria-label="عنوان ناحیه" />
      <input value={description} onChange={(e) => setDescription(e.target.value)} className="input !w-64 !py-1" aria-label="توضیح ناحیه" />
      <button
        className="btn-ghost !px-2 !py-1 !text-xs"
        disabled={pending}
        onClick={() => start(async () => { await updateZoneAction(zone.id, title, description); setSaved(true); setTimeout(() => setSaved(false), 1500); })}
      >
        {pending ? "..." : saved ? "ذخیره شد ✓" : "ذخیره"}
      </button>
    </div>
  );
}
