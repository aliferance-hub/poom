import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/identity";
import { toPersianDigits } from "@/lib/persian";

export const dynamic = "force-dynamic";

const STATUS_FA: Record<string, string> = {
  NEW: "جدید",
  IN_REVIEW: "در حال بررسی",
  RESOLVED: "برطرف شد",
  REJECTED: "رد شد",
};

const STATUS_BADGE: Record<string, string> = {
  NEW: "bg-blue-50 text-blue-700 border border-blue-200",
  IN_REVIEW: "bg-amber-50 text-amber-700 border border-amber-200",
  RESOLVED: "bg-green-50 text-green-700 border border-green-200",
  REJECTED: "bg-black/5 text-black/50 border border-black/10",
};

// Privacy: admins see a masked phone (last 4 digits visible).
function maskPhone(phone: string): string {
  if (!/^09\d{9}$/.test(phone)) return phone;
  return `${phone.slice(0, 4)}•••${phone.slice(-4)}`;
}

export default async function AdminInquiriesPage() {
  const admin = await requireAdmin();
  if (!admin) redirect("/login?next=/admin/inquiries");

  const inquiries = await prisma.partInquiry.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  const newCount = inquiries.filter((i) => i.status === "NEW").length;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">استعلام قطعه‌ها</h1>
        <Link href="/admin" className="text-sm underline hover:text-black/70">
          بازگشت به پنل مدیریت
        </Link>
      </div>

      <p className="mb-6 text-sm text-black/60">
        {newCount > 0
          ? `${toPersianDigits(newCount)} استعلام جدید در انتظار بررسی است.`
          : "استعلام جدیدی وجود ندارد."}
      </p>

      {inquiries.length === 0 ? (
        <div className="rounded-xl border border-black/10 bg-white p-6 text-sm text-black/50">
          هنوز هیچ استعلامی ثبت نشده است.
        </div>
      ) : (
        <div className="space-y-3">
          {inquiries.map((inq) => (
            <div key={inq.id} className="rounded-xl border border-black/10 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge text-[11px] ${STATUS_BADGE[inq.status] ?? ""}`}>
                  {STATUS_FA[inq.status] ?? inq.status}
                </span>
                <span className="font-medium">{inq.name}</span>
                <span className="font-mono text-sm text-black/70" dir="ltr">
                  {maskPhone(inq.phone)}
                </span>
                <span className="text-xs text-black/40">
                  {toPersianDigits(new Date(inq.createdAt).toLocaleDateString("fa-IR"))}
                </span>
              </div>

              {inq.partTitle || inq.partSlug ? (
                <p className="mt-2 text-sm">
                  قطعه:{" "}
                  {inq.partSlug ? (
                    <Link href={`/parts/${inq.partSlug}`} className="underline hover:text-black/70">
                      {inq.partTitle ?? inq.partSlug}
                    </Link>
                  ) : (
                    inq.partTitle
                  )}
                </p>
              ) : null}

              {inq.note ? <p className="mt-1 text-sm text-black/70">{inq.note}</p> : null}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
