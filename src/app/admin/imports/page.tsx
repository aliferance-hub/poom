import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";
import { prisma } from "@/lib/prisma";
import { toPersianDigits } from "@/lib/persian";
import { IngestForm } from "./client";

export default async function AdminImportsPage() {
  const a = await requireAdmin();
  if (!a) redirect("/login?next=/admin/imports");

  const batches = await prisma.importBatch.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { rows: true } } },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">واردات کاتالوگ ({toPersianDigits(batches.length)} دسته)</h1>
        <Link href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</Link>
      </div>

      <div className="card p-3 text-xs leading-5 text-black/60">
        گردش کار: ثبت RAW → نرمال‌سازی → اعتبارسنجی (تشخیص تکراری/تداخل با داده تأییدشده) → تأیید ادمین → commit اتمی.
        داده‌ی تأییدشده هرگز توسط واردات بازنویسی نمی‌شود (CONFLICT).
      </div>

      <IngestForm />

      <div className="card divide-y divide-black/6">
        {batches.length === 0 && <div className="p-4 text-sm text-black/50">هیچ دسته‌ای وجود ندارد.</div>}
        {batches.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div>
              <Link href={`/admin/imports/${b.id}`} className="font-medium hover:underline" dir="ltr">{b.label}</Link>
              <div className="text-[11px] text-black/50">
                {b.sourceRef} · {toPersianDigits(b._count.rows)} سطر · {b.status}{b.committedAt ? ` · ${b.committedAt.toISOString().slice(0, 10)}` : ""}
              </div>
            </div>
            <span className="badge bg-black/6">{b.format}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
