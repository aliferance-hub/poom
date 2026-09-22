// Garage activation race spike — the required P2-C concurrency scenario, run
// against the REAL database, outside the app process:
//
//   User ── Vehicle A / Vehicle B
//   Concurrent request 1: activate A   ┐  fired simultaneously
//   Concurrent request 2: activate B   ┘
//
// PASS criteria:
//   - exactly 1 active vehicle for the session afterwards (never 2, never 0)
//   - both requests resolve; loser waits on the session advisory lock then no-ops
//   - every activation goes through the production activateSavedVehicle() path
// Usage: node --import tsx scripts/spike-garage-race.mts  (from poom/)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SESSION = `spike_garage_${Date.now()}`;
const ROUNDS = 25; // race repetitions — small enough to stay quick, big enough to matter

async function main() {
  const v = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
  const variants = await prisma.vehicleVariant.findMany({ where: { vehicleId: v.id } });
  const t5 = variants.find((x) => x.trim === "تیپ ۵");
  const t2 = variants.find((x) => x.trim === "تیپ ۲");
  if (!t5 || !t2) throw new Error("seed missing 206 variants");

  const { createSavedVehicle, activateSavedVehicle, getMyVehicles } = await import("../src/lib/vehicle.ts");

  const a = await createSavedVehicle(SESSION, { variantId: t5.id, year: null, nickname: "A" });
  const b = await createSavedVehicle(SESSION, { variantId: t2.id, year: null, nickname: "B" });
  if (!a.ok || !b.ok) throw new Error("fixture failed: " + JSON.stringify({ a, b }));
  const idA = a.ok ? a.id : "";
  const idB = b.ok ? b.id : "";

  let bothOk = 0;
  let errors = 0;
  const errs: string[] = [];

  for (let round = 1; round <= ROUNDS; round++) {
    // Realistic interleaving: request 1 = activate A, request 2 = activate B,
    // fired in the same tick. Direction alternates per round.
    const task1 = round % 2 === 0 ? activateSavedVehicle(SESSION, idA) : activateSavedVehicle(SESSION, idB);
    const task2 = round % 2 === 0 ? activateSavedVehicle(SESSION, idB) : activateSavedVehicle(SESSION, idA);
    const [r1, r2] = await Promise.all([task1, task2]);
    if (r1.ok && r2.ok) bothOk++;
    if (!r1.ok || !r2.ok) {
      errors++;
      errs.push(JSON.stringify({ r1: r1.ok ? null : r1.error, r2: r2.ok ? null : r2.error }));
    }
    const actives = await prisma.garageVehicle.count({
      where: { sessionId: SESSION, isActive: true } as never,
    });
    if (actives !== 1) {
      console.error(`ROUND ${round}: INVARIANT VIOLATED — actives=${actives}`);
      process.exit(1);
    }
  }

  const finalActives = await prisma.garageVehicle.count({
    where: { sessionId: SESSION, isActive: true } as never,
  });
  const mine = await getMyVehicles(SESSION);

  // cleanup
  await prisma.garageVehicle.deleteMany({ where: { sessionId: SESSION } });

  const summary = { ROUNDS, bothOk, errors, errs: errs.slice(0, 3), finalActives, garageSize: mine.length };
  console.log(JSON.stringify(summary, null, 2));
  const pass = finalActives === 1 && errors === 0 && mine.length === 2;
  console.log(pass ? "GARAGE RACE SPIKE PASS ✔" : "GARAGE RACE SPIKE FAIL ✘");
  await prisma.$disconnect();
  if (!pass) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.garageVehicle.deleteMany({ where: { sessionId: SESSION } }).catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
