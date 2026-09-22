"use client";

import { useRef, useState } from "react";
import { toPersianDigits } from "@/lib/persian";

type PreviewRow = {
  rowNumber: number;
  status: "VALID" | "INVALID" | "WARNING";
  partTitle?: string;
  sellerSku?: string;
  price?: number;
  stock?: number;
  active?: boolean;
  error?: string;
};

/**
 * CSV import UX (§18): Upload → Parse → Validate → Preview → Commit.
 * Nothing is written until the seller reviews the preview and commits.
 */
export function CsvImportPanel() {
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [counts, setCounts] = useState<{ valid: number; invalid: number } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readFile(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      setFatal("حجم فایل بیش از حد مجاز است (حداکثر ۲ مگابایت).");
      return;
    }
    const text = await file.text();
    setCsvText(text);
    setPreview(null);
    setFatal(null);
    setResult(null);
  }

  async function doPreview() {
    setBusy(true); setFatal(null); setResult(null);
    try {
      const res = await fetch("/api/seller/inventory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText }),
      });
      const data = await res.json();
      if (data.fatal) { setFatal(data.fatal); setPreview(null); }
      else { setPreview(data.preview); setCounts({ valid: data.validCount, invalid: data.invalidCount }); }
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    setBusy(true); setFatal(null);
    try {
      const res = await fetch("/api/seller/inventory/import", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFatal(data.detail ?? data.fatal ?? "درون‌ریزی انجام نشد.");
      } else {
        setResult(`درون‌ریزی کامل شد: ${toPersianDigits(data.updatedCount)} ردیف بروزرسانی شد (همه‌یا-هیچ).`);
        setPreview(null);
        setTimeout(() => window.location.reload(), 1200);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <h2 className="text-sm font-semibold">سینک/درون‌ریزی موجودی (CSV)</h2>
      <p className="text-xs text-black/50">
        فایل CSV فقط آفرهای <b>خودتان</b> را بروزرسانی می‌کند (ستون‌ها: seller_sku, part_id, price_irr, stock, shipping_days_min, shipping_days_max, active). ردیف‌ها اول پیش‌نمایش می‌شوند؛ اگر حتی یک ردیف نامعتبر باشد، هیچ تغییریمی‌کند.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="text-xs"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }}
        />
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          rows={3}
          dir="ltr"
          placeholder="seller_sku,part_id,price_irr,stock,shipping_days_min,shipping_days_max,active"
          className="input w-full font-mono !text-xs"
          aria-label="محتوای CSV"
        />
        <div className="flex gap-2">
          <button className="btn-ghost !px-4 !text-sm" disabled={busy || !csvText.trim()} onClick={() => void doPreview()}>پیش‌نمایش</button>
          <button className="btn-ghost !px-4 !text-sm" disabled={busy || !preview || (counts?.invalid ?? 0) > 0} onClick={() => void doCommit()}>اعمال نهایی</button>
        </div>
      </div>

      {fatal && <div role="alert" className="rounded bg-red-100 p-2 text-xs text-red-900">{fatal}</div>}
      {result && <div role="status" className="rounded bg-green-100 p-2 text-xs text-green-900">{result}</div>}

      {preview && counts && (
        <div className="space-y-2">
          <div className="text-xs">
            اعتبار: <b className="text-green-800">{toPersianDigits(counts.valid)}</b> · نامعتبر: <b className="text-red-800">{toPersianDigits(counts.invalid)}</b>
          </div>
          <div className="max-h-64 overflow-auto rounded border border-black/10">
            <table className="w-full text-right text-xs">
              <thead className="bg-black/5">
                <tr>
                  <th className="p-1.5">ردیف</th>
                  <th className="p-1.5">قطعه</th>
                  <th className="p-1.5">SKU</th>
                  <th className="p-1.5">قیمت</th>
                  <th className="p-1.5">موجودی</th>
                  <th className="p-1.5">وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.rowNumber} className={r.status === "INVALID" ? "bg-red-50" : "bg-white/0"}>
                    <td className="p-1.5">{toPersianDigits(r.rowNumber)}</td>
                    <td className="p-1.5">{r.partTitle ?? "—"}</td>
                    <td className="p-1.5" dir="ltr">{r.sellerSku ?? "—"}</td>
                    <td className="p-1.5" dir="ltr">{r.price != null ? toPersianDigits(r.price) : "—"}</td>
                    <td className="p-1.5" dir="ltr">{r.stock != null ? toPersianDigits(r.stock) : "—"}</td>
                    <td className="p-1.5">
                      {r.status === "VALID" ? (
                        <span className="text-green-800">معتبر ✓</span>
                      ) : (
                        <span className="text-red-800" title={r.error}>نامعتبر: {r.error}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
