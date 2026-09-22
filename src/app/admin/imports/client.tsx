"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ingestCsvAction, normalizeBatchAction, validateBatchAction, approveBatchAction, commitBatchAction,
} from "./import-actions";

export function IngestForm() {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="card space-y-2 p-4"
      action={(fd) => start(async () => {
        const r = await ingestCsvAction(fd);
        setMessage(r.ok ? `دسته ساخته شد (${r.rowCount} سطر)` : `خطا: ${r.error}`);
      })}
    >
      <h2 className="font-semibold">ایجاد دسته‌ی واردات جدید</h2>
      <div className="grid gap-2 md:grid-cols-3">
        <input name="label" required placeholder="label (مثلا catalog-206-import-001)" className="input !py-1.5 !text-xs" dir="ltr" />
        <input name="sourceRef" required placeholder="sourceRef (منبع داده)" className="input !py-1.5 !text-xs" />
        <input name="sourceUpdatedAt" required type="date" placeholder="sourceUpdatedAt (تاریخ به‌روزرسانی منبع)" className="input !py-1.5 !text-xs" dir="ltr" />
        <input name="sourceUrl" placeholder="sourceUrl (اختیاری، عمومی)" className="input !py-1.5 !text-xs" dir="ltr" />
      </div>
      <textarea
        name="csv"
        required
        rows={6}
        dir="ltr"
        className="input !py-1.5 !text-xs font-mono"
        placeholder={"title,titleEn,sku,condition,categoryName,brandName,assemblySlug,identifiers,technicalDescription\nلنت ترمز جلو 206,Brake pad front,206-BP-001,NEW,ترمز,Brembo,brakes,OEM:4251.F2;MPN:BP206F,سایز استاندارد"}
      />
      <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={pending}>
        {pending ? "در حال ثبت…" : "ثبت دسته (RAW)"}
      </button>
      {message && <div className="rounded bg-blue-50 p-2 text-xs text-blue-800">{message}</div>}
    </form>
  );
}

const STATUS_FA: Record<string, string> = {
  DRAFT: "پیش‌نویس", VALIDATED: "اعتبارسنجی‌شده", APPROVED: "تأییدشده",
  COMMITTED: "اعمال‌شده", FAILED: "ناموفق", REJECTED: "ردشده",
};

export function PipelineButtons({ batchId, status }: { batchId: string; status: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      setMessage(r.ok ? done : `خطا: ${r.error ?? "نامشخص"}`);
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="badge bg-black/6">وضعیت: {STATUS_FA[status] ?? status}</span>
      {status === "DRAFT" && (
        <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={pending}
          onClick={() => run(() => normalizeBatchAction(batchId), "نرمال‌سازی انجام شد")}>
          نرمال‌سازی
        </button>
      )}
      {status === "DRAFT" && (
        <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={pending}
          onClick={() => run(async () => {
            const n = await normalizeBatchAction(batchId);
            if (!n.ok) return n;
            return validateBatchAction(batchId);
          }, "اعتبارسنجی انجام شد")}>
          نرمال‌سازی + اعتبارسنجی
        </button>
      )}
      {status === "VALIDATED" && (
        <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={pending}
          onClick={() => run(() => approveBatchAction(batchId), "دسته تأیید شد")}>
          تأیید دسته
        </button>
      )}
      {status === "APPROVED" && (
        <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={pending}
          onClick={() => run(() => commitBatchAction(batchId), "دسته اعمال شد (commit)")}>
          اعمال (commit)
        </button>
      )}
      {message && <span className="text-xs text-blue-700">{message}</span>}
    </div>
  );
}
