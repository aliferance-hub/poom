"use client";

import { useState } from "react";
import { submitPartInquiry, type SubmitInquiryResult } from "@/lib/inquiries";

type Props = {
  partSlug?: string;
  partTitle?: string;
  compact?: boolean;
};

export function InquiryForm({ partSlug, partTitle, compact }: Props) {
  const [result, setResult] = useState<SubmitInquiryResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData(e.currentTarget);
      const res = await submitPartInquiry(fd);
      setResult(res);
      if (res.ok) e.currentTarget.reset();
    } catch {
      setResult({ ok: false, error: "خطای شبکه. دوباره تلاش کنید." });
    } finally {
      setBusy(false);
    }
  }

  if (result?.ok) {
    return (
      <div className={`rounded-xl border border-green-200 bg-green-50 p-4 text-green-800 ${compact ? "text-sm" : ""}`}>
        <p className="font-medium">{result.message}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className={`space-y-3 ${compact ? "text-sm" : ""}`}>
      {partSlug ? <input type="hidden" name="partSlug" value={partSlug} /> : null}
      {partTitle ? <input type="hidden" name="partTitle" value={partTitle} /> : null}
      {/* honeypot — hidden from humans */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />

      <div className={compact ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "grid grid-cols-1 gap-3 sm:grid-cols-2"}>
        <div>
          <label htmlFor={`inq-name-${partSlug ?? "page"}`} className="mb-1 block text-xs text-black/60">
            نام شما
          </label>
          <input
            id={`inq-name-${partSlug ?? "page"}`}
            name="name"
            required
            minLength={2}
            maxLength={60}
            className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 outline-none focus:border-black/40"
            placeholder="مثلاً علی رضایی"
          />
        </div>
        <div>
          <label htmlFor={`inq-phone-${partSlug ?? "page"}`} className="mb-1 block text-xs text-black/60">
            شمارهٔ موبایل
          </label>
          <input
            id={`inq-phone-${partSlug ?? "page"}`}
            name="phone"
            required
            inputMode="tel"
            dir="ltr"
            className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-left outline-none focus:border-black/40"
            placeholder="09123456789"
          />
        </div>
      </div>

      <div>
        <label htmlFor={`inq-note-${partSlug ?? "page"}`} className="mb-1 block text-xs text-black/60">
          توضیحات (اختیاری)
        </label>
        <textarea
          id={`inq-note-${partSlug ?? "page"}`}
          name="note"
          rows={compact ? 2 : 3}
          maxLength={500}
          className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 outline-none focus:border-black/40"
          placeholder="مثلاً مدل سال ۸۵ هست و دنبال رادیاتور اصلی می‌گردم…"
        />
      </div>

      {result && !result.ok ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{result.error}</p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-black px-4 py-2.5 font-medium text-white transition hover:bg-black/85 disabled:opacity-50 sm:w-auto"
      >
        {busy ? "در حال ثبت…" : "ثبت درخواست تماس"}
      </button>
    </form>
  );
}
