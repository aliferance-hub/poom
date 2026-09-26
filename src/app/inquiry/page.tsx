import type { Metadata } from "next";
import Link from "next/link";
import { InquiryForm } from "@/components/inquiry-form";

export const metadata: Metadata = {
  title: "استعلام قطعه ۲۰۶",
  description: "قطعهٔ موردنیاز خود را ثبت کنید تا برای هماهنگی با شما تماس بگیریم.",
  alternates: { canonical: "/inquiry" },
};

export default function InquiryPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">استعلام قطعه</h1>
      <p className="mt-2 text-black/70">
        اگر قطعهٔ موردنیازتان را در فروشگاه پیدا نکردید، همین‌جا ثبت کنید.
        پس از بررسی، برای هماهنگی با شما تماس می‌گیریم.
      </p>
      <p className="mt-4 text-sm text-black/60">
        فهرست فعلی قطعه‌ها را می‌توانید در{" "}
        <Link href="/" className="underline hover:text-black">
          صفحهٔ اصلی فروشگاه
        </Link>{" "}
        ببینید.
      </p>

      <section className="mt-8 rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
        <h2 className="mb-4 font-semibold">فرم درخواست تماس</h2>
        <InquiryForm />
      </section>

      <p className="mt-6 text-xs leading-relaxed text-black/50">
        این فرم فقط برای ثبت درخواست است و هزینه یا تعهدی ایجاد نمی‌کند.
        شمارهٔ شما فقط برای تماس دربارهٔ همین درخواست استفاده می‌شود.
      </p>
    </main>
  );
}
