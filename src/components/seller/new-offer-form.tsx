"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOfferAction } from "@/app/seller/seller-actions";

/**
 * P2-G: publish a new offer on a REAL catalog part. Server validates seller
 * governance status (ACTIVE) and part eligibility (sourceRef present).
 */
export function NewOfferForm({ sellableParts }: { sellableParts: { slug: string; title: string; sku: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const r = await createOfferAction(formData);
      if (r.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  };

  if (!open) {
    return (
      <button className="btn-primary !py-1.5 !text-xs" onClick={() => setOpen(true)}>
        + آفر جدید
      </button>
    );
  }

  return (
    <form action={submit} className="card w-full space-y-3 p-4">
      <div className="font-semibold text-sm">انتشار آفر روی قطعه‌ی واقعی</div>
      <label className="block text-sm">
        <span className="mb-1 block">قطعه *</span>
        <select name="partSlug" required className="input">
          {sellableParts.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.title} ({p.sku})
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block">قیمت (ریال — یک تومان = ۱۰ ریال) *</span>
          <input name="priceIrr" required type="number" min={1} step={1} className="input" dir="ltr" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block">موجودی *</span>
          <input name="stock" required type="number" min={0} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block">حداقل زمان ارسال (روز)</span>
          <input name="shippingDaysMin" type="number" min={0} max={60} defaultValue={1} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block">حداکثر زمان ارسال (روز)</span>
          <input name="shippingDaysMax" type="number" min={0} max={90} defaultValue={3} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block">SKU فروشنده</span>
          <input name="sellerSku" maxLength={40} className="input" dir="ltr" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block">گارانتی</span>
          <input name="warrantyFa" maxLength={120} className="input" />
        </label>
      </div>
      {error && <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</div>}
      <div className="flex gap-2">
        <button disabled={pending} className="btn-primary">{pending ? "…" : "انتشار"}</button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>انصراف</button>
      </div>
      <p className="text-[11px] text-black/45">
        آفرهای شما روی داده‌ی کاتالوگ ادمین اضافه می‌شوند؛ نام/مشخصات قطعه را نمی‌توان تغییر داد.
      </p>
    </form>
  );
}
