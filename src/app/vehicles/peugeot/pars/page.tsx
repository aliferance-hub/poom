import Link from "next/link";
import { notFound } from "next/navigation";
import { getVehicleWithVariants, getZonesForVehicle } from "@/lib/catalog";
import { getAssetContractForVehicle } from "@/lib/registry3d";
import { VehicleViewer } from "@/components/viewer/vehicle-viewer";

export const metadata = { title: "پژو پارس | پوم" };

/**
 * P2-Pars: second vehicle page. The Pars GLB is a PLACEHOLDER (source states
 * no license/creator) — availability labeling stays automatic via the
 * contract (vehicle3d=PLACEHOLDER → «نمونهٔ جایگزین»).
 */
export default async function ParsVehiclePage() {
  const vehicle = await getVehicleWithVariants("Peugeot", "Pars");
  if (!vehicle) notFound();

  const zones = await getZonesForVehicle(vehicle.id);
  const contract = await getAssetContractForVehicle(vehicle.id);

  return (
    <div className="space-y-4">
      <nav className="text-xs text-black/50" aria-label="breadcrumb">
        <Link href="/" className="hover:underline">خانه</Link> / پژو پارس
      </nav>

      <h1 className="text-xl font-bold">پژو پارس</h1>

      <VehicleViewer
        contract={contract}
        zones={zones.map((z) => ({ key: z.key, title: z.title, description: z.description }))}
        vehicleBasePath="/vehicles/peugeot/pars"
      />

      <p className="text-[11px] leading-5 text-black/45">
        مدل سه‌بعدی فعلی پژو پارس یک نمونهٔ جایگزین است (مدل واقعی با مجوز ثبت نشده است) و ممکن است با خودروی واقعی تفاوت داشته باشد.
      </p>

      <section>
        <h2 className="mb-3 text-lg font-bold">همه نواحی</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {zones.map((z) => (
            <Link key={z.id} href={`/vehicles/peugeot/pars/zone/${z.key}`} className="card p-4 hover:shadow-md">
              <div className="font-semibold">{z.title}</div>
              <div className="mt-1 text-xs text-black/50">{z.description}</div>
              <div className="mt-2 text-[11px] text-black/35">
                {z._count.assemblies > 0 ? `${z._count.assemblies} اسمبلی` : "هنوز اسمبلی ثبت نشده"}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
