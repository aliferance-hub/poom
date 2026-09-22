"use client";

import { useState, useTransition } from "react";
import {
  createFitmentAction, updateFitmentAction, deleteFitmentAction, setFitmentStatusAction,
} from "@/app/admin/fitment/actions";
import { toPersianDigits } from "@/lib/persian";

type Row = {
  id: string; partTitle: string; vehicleName: string; variantTrim: string | null;
  engine: string | null; transmission: string | null; bodyType: string | null;
  yearFrom: number | null; yearTo: number | null;
  fitmentStatus: string; fitmentNote: string | null;
  partId: string; vehicleId: string; variantId: string | null;
};

type Props = {
  parts: { id: string; title: string; sku: string }[];
  vehicles: { id: string; displayName: string; variants: { id: string; trim: string; engine: string | null; transmission: string | null }[] }[];
  fitments: Row[];
  statusLabels: Record<string, string>;
  statusBadges: Record<string, string>;
};

const ALL_STATUSES = ["CONFIRMED", "PARTIAL", "PENDING_REVIEW", "REJECTED"] as const;

export function FitmentEditor({ parts, vehicles, fitments, statusLabels, statusBadges }: Props) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState({
    partId: parts[0]?.id ?? "",
    vehicleId: vehicles[0]?.id ?? "",
    variantId: "",
    engine: "",
    transmission: "",
    bodyType: "",
    yearFrom: "",
    yearTo: "",
    fitmentStatus: "CONFIRMED" as (typeof ALL_STATUSES)[number],
    fitmentNote: "",
  });

  const vehicle = vehicles.find((v) => v.id === form.vehicleId);
  const shown = fitments.filter((f) =>
    !filter || f.partTitle.includes(filter) || f.partTitle.includes(filter.trim()),
  );

  const submit = () => {
    setMessage(null);
    start(async () => {
      const payload = {
        partId: form.partId,
        vehicleId: form.vehicleId,
        variantId: form.variantId || null,
        engine: form.engine || null,
        transmission: form.transmission || null,
        bodyType: form.bodyType || null,
        yearFrom: form.yearFrom ? Number(form.yearFrom) : null,
        yearTo: form.yearTo ? Number(form.yearTo) : null,
        fitmentStatus: form.fitmentStatus,
        fitmentNote: form.fitmentNote || null,
      };
      const res = await createFitmentAction(payload);
      setMessage(res.ok ? "قانون سازگاری ذخیره شد" : `خطا: ${res.error}`);
    });
  };

  return (
    <div className="space-y-4">
      {/* create form */}
      <section className="card space-y-2 p-4" data-testid="fitment-form">
        <h2 className="font-semibold">قانون جدید / ویرایش قانون موجود</h2>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
          <select className="input !py-1.5 !text-xs" value={form.partId} onChange={(e) => setForm({ ...form, partId: e.target.value })} aria-label="قطعه">
            {parts.map((p) => <option key={p.id} value={p.id}>{p.title} — {p.sku}</option>)}
          </select>
          <select className="input !py-1.5 !text-xs" value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value, variantId: "" })} aria-label="خودرو">
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.displayName}</option>)}
          </select>
          <select className="input !py-1.5 !text-xs" value={form.variantId} onChange={(e) => setForm({ ...form, variantId: e.target.value })} aria-label="تیپ">
            <option value="">همه تیپ‌ها (vehicle-level)</option>
            {vehicle?.variants.map((v) => <option key={v.id} value={v.id}>{v.trim} — {v.engine ?? "?"}</option>)}
          </select>
          <select className="input !py-1.5 !text-xs" value={form.fitmentStatus} onChange={(e) => setForm({ ...form, fitmentStatus: e.target.value as (typeof ALL_STATUSES)[number] })} aria-label="وضعیت">
            {ALL_STATUSES.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
          </select>
          <input className="input !py-1.5 !text-xs" placeholder="موتور (مثلا TU5 (DEMO))" value={form.engine} onChange={(e) => setForm({ ...form, engine: e.target.value })} dir="ltr" aria-label="موتور" />
          <input className="input !py-1.5 !text-xs" placeholder="گیربکس" value={form.transmission} onChange={(e) => setForm({ ...form, transmission: e.target.value })} aria-label="گیربکس" />
          <input className="input !py-1.5 !text-xs" placeholder="نوع بدنه" value={form.bodyType} onChange={(e) => setForm({ ...form, bodyType: e.target.value })} aria-label="نوع بدنه" />
          <div className="flex gap-1">
            <input className="input !py-1.5 !text-xs" placeholder="از سال" value={form.yearFrom} onChange={(e) => setForm({ ...form, yearFrom: e.target.value.replace(/[^0-9]/g, "") })} inputMode="numeric" aria-label="از سال" />
            <input className="input !py-1.5 !text-xs" placeholder="تا سال" value={form.yearTo} onChange={(e) => setForm({ ...form, yearTo: e.target.value.replace(/[^0-9]/g, "") })} inputMode="numeric" aria-label="تا سال" />
          </div>
        </div>
        <input className="input !py-1.5 !text-xs" placeholder="یادداشت (مثلا: فقط برای تیپ ۵)" value={form.fitmentNote} onChange={(e) => setForm({ ...form, fitmentNote: e.target.value })} aria-label="یادداشت" />
        <div className="flex items-center gap-2">
          <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={pending || !form.partId || !form.vehicleId} onClick={submit}>
            ذخیره قانون
          </button>
          {message && <span className="text-xs" data-testid="fitment-message">{message}</span>}
        </div>
      </section>

      {/* search */}
      <input
        className="input !py-1.5 !text-xs max-w-xs"
        placeholder="جستجوی قطعه…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="جستجوی قانون"
      />

      {/* rows */}
      <div className="card divide-y divide-black/6">
        {shown.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-testid="fitment-row">
            <div className="min-w-0">
              <div className="truncate font-medium">{f.partTitle}</div>
              <div className="text-[11px] text-black/50">
                {f.vehicleName}{f.variantTrim ? ` · ${f.variantTrim}` : " · همه تیپ‌ها"}
                {f.engine ? ` · ${f.engine}` : ""}
                {f.yearFrom != null && ` · ${toPersianDigits(f.yearFrom)}–${toPersianDigits(f.yearTo ?? 0)}`}
                {f.fitmentNote ? ` · ${f.fitmentNote}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <select
                className={`badge border-0 ${statusBadges[f.fitmentStatus] ?? "bg-black/6"}`}
                value={f.fitmentStatus}
                disabled={pending}
                onChange={(e) => start(async () => {
                  await setFitmentStatusAction(f.id, e.target.value as (typeof ALL_STATUSES)[number]);
                })}
                aria-label="تغییر وضعیت"
              >
                {ALL_STATUSES.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
              </select>
              <button
                className="btn-ghost !px-2 !py-1 !text-xs !text-red-600"
                disabled={pending}
                onClick={() => start(async () => {
                  await deleteFitmentAction(f.id);
                  setMessage("قانون حذف شد");
                })}
              >
                حذف
              </button>
            </div>
          </div>
        ))}
        {shown.length === 0 && <div className="p-4 text-sm text-black/50">قانونی یافت نشد.</div>}
      </div>
      <p className="text-[10px] text-black/40">
        فروشندگان و مشتریان هیچ دسترسی‌ای به تغییر این قوانین ندارند — فقط ادمین (در حالت نمایشی، مرز اعتماد DEMO).
      </p>
    </div>
  );
}
