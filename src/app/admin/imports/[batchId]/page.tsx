import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";
import { prisma } from "@/lib/prisma";
import { toPersianDigits } from "@/lib/persian";
import { PipelineButtons } from "../client";

export default async function AdminImportBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const a = await requireAdmin();
  if (!a) redirect("/login?next=/admin/imports");
  const { batchId } = await params;

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { rowNumber: "asc" }, take: 200 } },
  });
  if (!batch) notFound();

  const counts = batch.rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold" dir="ltr">{batch.label}</h1>
          <div className="text-xs text-black/50">منبع: {batch.sourceRef}{batch.sourceUrl ? ` · ${batch.sourceUrl}` : ""}</div>
        </div>
        <Link href="/admin/imports" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت</Link>
      </div>

      <PipelineButtons batchId={batch.id} status={batch.status} />

      <div className="flex flex-wrap gap-2 text-xs">
        {Object.entries(counts).map(([k, v]) => (
          <span key={k} className="badge bg-black/6">{k}: {toPersianDigits(v)}</span>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-black/8 text-black/50">
              <th className="p-2 text-start">#</th>
              <th className="p-2 text-start">وضعیت</th>
              <th className="p-2 text-start">اقدام</th>
              <th className="p-2 text-start">عنوان</th>
              <th className="p-2 text-start">شناسه‌ها</th>
              <th className="p-2 text-start">مشکلات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5">
            {batch.rows.map((r) => {
              const norm = r.normalizedJson as { title?: string; identifiers?: { type: string; value: string }[] } | null;
              return (
                <tr key={r.id}>
                  <td className="p-2" dir="ltr">{r.rowNumber}</td>
                  <td className="p-2">
                    <span className={`badge ${r.status === "VALID" || r.status === "APPROVED" || r.status === "APPLIED" ? "bg-green-100 text-green-800" : r.status === "INVALID" || r.status === "REJECTED" ? "bg-red-100 text-red-700" : "bg-black/6"}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="p-2" dir="ltr">{r.action ?? "—"}</td>
                  <td className="p-2">{norm?.title ?? "—"}</td>
                  <td className="p-2" dir="ltr">{norm?.identifiers?.map((i) => `${i.type}:${i.value}`).join(" · ") || "—"}</td>
                  <td className="p-2 text-red-700" dir="ltr">{r.problems.length > 0 ? r.problems.join(", ") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
