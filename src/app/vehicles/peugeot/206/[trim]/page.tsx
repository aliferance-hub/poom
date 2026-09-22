import Link from "next/link";
import { notFound } from "next/navigation";
import { getVehicleWithVariants, getZonesForVehicle } from "@/lib/catalog";
import { getAssetContractForVehicle } from "@/lib/registry3d";
import { VehicleViewer } from "@/components/viewer/vehicle-viewer";

const TRIM_SLUGS: Record<string, string> = { "type-2": "تیپ ۲", "type-5": "تیپ ۵" };

export default async function VehicleTrimPage({ params }: { params: Promise<{ trim: string }> }) {
  const { trim } = await params;
  const selectedTrim = TRIM_SLUGS[trim];
  if (!selectedTrim) notFound();

  const vehicle = await getVehicleWithVariants("Peugeot", "206");
  if (!vehicle) notFound();

  const zones = await getZonesForVehicle(vehicle.id);
  const contract = await getAssetContractForVehicle(vehicle.id);
  const variant = vehicle.variants.find((v) => v.trim === selectedTrim);

  return (
    <div className="space-y-4">
      <nav className="text-xs text-black/50" aria-label="breadcrumb">
        <Link href="/" className="hover:underline">خانه</Link> / پژو ۲۰۶ / {selectedTrim}
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">پژو ۲۰۶ — {selectedTrim}</h1>
        <div className="flex gap-1">
          {vehicle.variants.map((v) => {
            const slug = v.trim === "تیپ ۲" ? "type-2" : "type-5";
            const active = v.trim === selectedTrim;
            return (
              <Link key={v.id} href={`/vehicles/peugeot/206/${slug}`}
                className={`badge ${active ? "bg-[var(--color-accent)] text-white" : "bg-black/6 hover:bg-black/10"}`}>
                {v.trim}
              </Link>
            );
          })}
        </div>
        {variant?.engine && <span className="text-xs text-black/40">موتور (DEMO): {variant.engine}</span>}
      </div>

      <VehicleViewer
        contract={contract}
        variantId={variant?.id}
        zones={zones.map((z) => ({ key: z.key, title: z.title, description: z.description }))}
      />

      <section>
        <h2 className="mb-3 text-lg font-bold">همه نواحی</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {zones.map((z) => (
            <Link key={z.id} href={`/vehicles/peugeot/206/zone/${z.key}`} className="card p-4 hover:shadow-md">
              <div className="font-semibold">{z.title}</div>
              <div className="mt-1 text-xs text-black/50">{z.description}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
