import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";

const __adminGate = async () => { const a = await requireAdmin(); if (!a) redirect("/login?next=/admin"); return a; };
import { prisma } from "@/lib/prisma";
import { toPersianDigits } from "@/lib/persian";

export default async function AdminVehiclesPage() {
  await __adminGate();
  const vehicles = await prisma.vehicle.findMany({
    include: {
      variants: { include: { _count: { select: { fitments: true } } } },
      _count: { select: { zones: true, fitments: true } },
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">خودروها و تیپ‌ها</h1>
        <Link href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</Link>
      </div>

      {vehicles.map((v) => (
        <div key={v.id} className="card space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-bold">{v.displayName}</span>
              <span className="text-xs text-black/45"> · {v.make} {v.model} · نسل {v.generation ?? "—"} · {v.bodyType ?? "—"}</span>
            </div>
            <span className="text-[11px] text-black/45">
              {toPersianDigits(v._count.zones)} ناحیه · {toPersianDigits(v._count.fitments)} قانون سازگاری
            </span>
          </div>
          <div className="divide-y divide-black/6">
            {v.variants.map((vr) => (
              <div key={vr.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs">
                <span className="font-medium">{vr.trim}</span>
                <span className="text-black/50" dir="ltr">{vr.engine ?? "—"} · {vr.transmission ?? "—"}</span>
                <span className="text-black/50">
                  {toPersianDigits(vr.productionStart ?? 0)}–{toPersianDigits(vr.productionEnd ?? 0)}
                </span>
                <span className="badge bg-black/5 text-[10px]">{toPersianDigits(vr._count.fitments)} قانون</span>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-black/35">مقادیر موتور/گیربکس/سال‌ها DEMO هستند — نیازمند تأیید کارشناس.</div>
        </div>
      ))}
    </div>
  );
}
