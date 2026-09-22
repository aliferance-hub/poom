"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyAsSellerAction } from "@/app/seller/seller-actions";

export function ApplyForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const r = await applyAsSellerAction(formData);
      if (r.ok) router.push("/seller?applied=1");
      else setError(r.errors?.join(" ") ?? r.reason);
    });
  };

  return (
    <form action={submit} className="card space-y-3 p-4">
      <label className="block text-sm">
        <span className="mb-1 block">نام کسب‌وکار *</span>
        <input name="businessName" required minLength={3} maxLength={80} className="input" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block">نام مدیر</span>
          <input name="ownerName" maxLength={80} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block">شهر</span>
          <input name="city" maxLength={40} className="input" />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block">آدرس</span>
        <input name="address" maxLength={160} className="input" />
      </label>
      {error && <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</div>}
      <button disabled={pending} className="btn-primary">
        {pending ? "در حال ارسال…" : "ثبت درخواست"}
      </button>
      <p className="text-[11px] text-black/45">
        درخواست ثبت‌نام هیچ دسترسی فروشندگی نمی‌دهد تا زمانی که ادمین آن را تأیید کند.
      </p>
    </form>
  );
}
