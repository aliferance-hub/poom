"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveProfileAction } from "@/app/seller/seller-actions";

type Profile = {
  businessName: string; ownerName: string; phone: string; city: string; address: string;
};

/** Seller-owned profile fields only (Zod whitelist server-side). */
export function ProfileForm({ initial }: { initial: Profile }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function submit(form: FormData) {
    start(async () => {
      setError(null);
      const res = await saveProfileAction(form);
      if (!res.ok) setError(res.error ?? "خطا");
      else router.refresh();
    });
  }

  return (
    <form action={submit} className="card grid gap-3 p-4 md:grid-cols-2">
      <label className="text-sm">
        نام فروشگاه
        <input name="businessName" defaultValue={initial.businessName} required minLength={2} maxLength={60} className="input mt-1 w-full" />
      </label>
      <label className="text-sm">
        نام مسئول
        <input name="ownerName" defaultValue={initial.ownerName} maxLength={60} className="input mt-1 w-full" />
      </label>
      <label className="text-sm">
        تلفن
        <input name="phone" defaultValue={initial.phone} dir="ltr" pattern="0\d{9,10}" className="input mt-1 w-full" placeholder="02112345678" />
      </label>
      <label className="text-sm">
        شهر
        <input name="city" defaultValue={initial.city} maxLength={40} className="input mt-1 w-full" />
      </label>
      <label className="text-sm md:col-span-2">
        آدرس
        <textarea name="address" defaultValue={initial.address} maxLength={200} rows={2} className="input mt-1 w-full" />
      </label>
      {error && <div role="alert" className="rounded bg-red-100 p-2 text-xs text-red-900 md:col-span-2">{error}</div>}
      <div className="md:col-span-2">
        <button type="submit" className="btn-ghost !px-6" disabled={pending}>{pending ? "..." : "ذخیره پروفایل"}</button>
      </div>
    </form>
  );
}
