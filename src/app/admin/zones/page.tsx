import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";

const __adminGate = async () => { const a = await requireAdmin(); if (!a) redirect("/login?next=/admin"); return a; };
import { prisma } from "@/lib/prisma";
import { ZoneEditor } from "@/components/zone-editor";

export default async function AdminZonesPage() {
  await __adminGate();
  const zones = await prisma.vehicleZone.findMany({
    orderBy: { sortOrder: "asc" },
    include: { vehicle: true },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">مدیریت نواحی</h1>
        <Link href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</Link>
      </div>
      <div className="space-y-2">
        {zones.map((z) => (
          <ZoneEditor key={z.id} zone={{ id: z.id, title: z.title, description: z.description ?? "", vehicle: z.vehicle.displayName, key: z.key }} />
        ))}
      </div>
    </div>
  );
}
