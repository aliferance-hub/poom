// TEMP probe: what error code escapes activateSavedVehicle under 10-way race?
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SESSION = `probe_p2034_${Date.now()}`;

async function main() {
  const v = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
  const variants = await prisma.vehicleVariant.findMany({ where: { vehicleId: v.id } });
  const t5 = variants.find((x) => x.trim === "تیپ ۵")!;
  const t2 = variants.find((x) => x.trim === "تیپ ۲")!;
  const { createSavedVehicle, activateSavedVehicle } = await import("../src/lib/vehicle.ts");

  const a = await createSavedVehicle(SESSION, { variantId: t5.id, year: null, nickname: null });
  const b = await createSavedVehicle(SESSION, { variantId: t2.id, year: null, nickname: null });
  const idA = a.ok ? a.id : "";
  const idB = b.ok ? b.id : "";

  // Same 10-way race as the failing test, but log every rejection verbatim.
  const settled = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => activateSavedVehicle(SESSION, i % 2 === 0 ? idA : idB)),
  );
  const errs = settled
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => ({
      name: (r.reason as Error)?.name,
      code: (r.reason as { code?: string })?.code,
      pgCode: (r.reason as { meta?: { code?: string } })?.meta?.code,
      message: String(r.reason).slice(0, 140),
    }));

  const actives = await prisma.garageVehicle.count({ where: { sessionId: SESSION, isActive: true } as never });
  console.log(JSON.stringify({ errs, actives }, null, 2));

  await prisma.garageVehicle.deleteMany({ where: { sessionId: SESSION } as never });
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.garageVehicle.deleteMany({ where: { sessionId: SESSION } as never }).catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
