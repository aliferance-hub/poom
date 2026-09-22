import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";

const __adminGate = async () => { const a = await requireAdmin(); if (!a) redirect("/login?next=/admin"); return a; };
import { prisma } from "@/lib/prisma";
import { toPersianDigits } from "@/lib/persian";
import { FitmentEditor } from "@/components/admin/fitment-editor";

const STATUSES = ["PENDING_REVIEW", "PARTIAL", "CONFIRMED", "REJECTED"] as const;
const FA: Record<string, string> = {
  CONFIRMED: "تأیید شده", PARTIAL: "جزئی", PENDING_REVIEW: "در انتظار بررسی", REJECTED: "رد شده",
};
const STATUS_BADGE: Record<string, string> = {
  CONFIRMED: "bg-green-100 text-green-800",
  PARTIAL: "bg-amber-100 text-amber-800",
  PENDING_REVIEW: "bg-yellow-50 text-yellow-700",
  REJECTED: "bg-red-100 text-red-700",
};

export default async function AdminFitmentPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  await __adminGate();
  const { status, q } = await searchParams;
  const validStatus = STATUSES.includes((status ?? "") as (typeof STATUSES)[number]) ? (status as (typeof STATUSES)[number]) : null;

  const [fitments, parts, vehicles, reviewCount] = await Promise.all([
    prisma.fitment.findMany({
      where: {
        ...(validStatus ? { fitmentStatus: validStatus } : {}),
        ...(q ? { part: { title: { contains: q, mode: "insensitive" } } } : {}),
      },
      include: { part: { select: { title: true, sku: true } }, vehicle: { select: { displayName: true } }, variant: { select: { trim: true } } },
      orderBy: [{ fitmentStatus: "asc" }, { id: "asc" }],
      take: 80,
    }),
    prisma.part.findMany({ select: { id: true, title: true, sku: true }, orderBy: { title: "asc" }, take: 300 }),
    prisma.vehicle.findMany({ select: { id: true, displayName: true, variants: { select: { id: true, trim: true, engine: true, transmission: true } } } }),
    prisma.fitment.count({ where: { fitmentStatus: { in: ["PENDING_REVIEW", "PARTIAL"] } } }),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">مدیریت سازگاری (Fitment)</h1>
        <div className="flex gap-2 text-sm">
          {reviewCount > 0 && (
            <Link href="/admin/fitment?status=PENDING_REVIEW" className="badge bg-amber-100 text-amber-800">
              صف بررسی: {toPersianDigits(reviewCount)}
            </Link>
          )}
          <Link href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</Link>
        </div>
      </div>

      <FitmentEditor
        parts={parts}
        vehicles={vehicles.map((v) => ({ id: v.id, displayName: v.displayName, variants: v.variants }))}
        fitments={fitments.map((f) => ({
          id: f.id,
          partTitle: f.part.title,
          vehicleName: f.vehicle.displayName,
          variantTrim: f.variant?.trim ?? null,
          engine: f.engine,
          transmission: f.transmission,
          bodyType: f.bodyType,
          yearFrom: f.yearFrom,
          yearTo: f.yearTo,
          fitmentStatus: f.fitmentStatus,
          fitmentNote: f.fitmentNote,
          partId: f.partId,
          vehicleId: f.vehicleId,
          variantId: f.variantId,
        }))}
        statusLabels={FA}
        statusBadges={STATUS_BADGE}
      />
    </div>
  );
}
