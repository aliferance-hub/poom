"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { AssetContract } from "@/lib/registry3d";

export type ZoneInfo = { key: string; title: string; description: string | null };

const CarScene = dynamic(() => import("./car-scene").then((m) => m.CarScene), {
  ssr: false,
  loading: () => (
    <div className="grid h-[420px] w-full place-items-center rounded-xl border border-black/8 bg-white text-sm text-black/45 md:h-[520px]">
      در حال بارگذاری نمای سه‌بعدی…
    </div>
  ),
});

export function VehicleViewer({
  contract, zones, variantId, focusPart, vehicleBasePath = "/vehicles/peugeot/206",
}: {
  contract: AssetContract | null;
  zones: ZoneInfo[];
  variantId?: string;
  /** PDP focus mode: meshName of the part to highlight (car renders as ghost). */
  focusPart?: string | null;
  /** Base path for zone deep-links; defaults to the historical 206 pages. */
  vehicleBasePath?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!contract || failed) {
    return (
      <div className="card p-6">
        <div className="mb-3 text-sm font-semibold text-black/70">
          نمای سه‌بعدی در دسترس نیست — از فهرست نواحی استفاده کنید.
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {zones.map((z) => (
            <a key={z.key} href={`${vehicleBasePath}/zone/${z.key}`}
              className="rounded-lg border border-black/8 p-2 text-center text-sm hover:bg-black/3">
              {z.title}
            </a>
          ))}
        </div>
        <p className="mt-3 text-[10px] text-black/40">
          Asset Contract بارگذاری شد ولی نمایش سه‌بعدی در دسترس نیست. {variantId ? "" : ""}
        </p>
      </div>
    );
  }

  return (
    <CarScene
      contract={contract}
      zones={zones}
      focusPart={focusPart}
      vehicleBasePath={vehicleBasePath}
      onWebglFail={() => setFailed(true)}
    />
  );
}
