/**
 * P2-G audit helper: mint a live preview session that owns an ACTIVE Peugeot 206
 * (تیپ ۲) garage vehicle, so the vehicle-aware surfaces (search fitment labels)
 * can be exercised over HTTP with a real session cookie. Prints the opaque
 * poom_session token on stdout; the row is left in place for the walkthrough and
 * removed by the caller afterwards.
 */
import { PrismaClient } from "@prisma/client";
import { createSession } from "@/lib/auth/session";
import { createSavedVehicle, activateSavedVehicle } from "@/lib/vehicle";

const prisma = new PrismaClient();

async function main() {
  const phone = `09${Date.now().toString().slice(-9)}`;
  const user = await prisma.user.create({ data: { phone, role: "CUSTOMER" } });
  const { token } = await createSession(user.id);

  const variant = await prisma.vehicleVariant.findFirstOrThrow({
    where: { vehicle: { model: "206" }, trim: "تیپ ۲" },
    select: { id: true },
  });
  const created = await createSavedVehicle(token, { variantId: variant.id, nickname: "پروب جستجو" });
  if (!created.ok) throw new Error(`createSavedVehicle failed: ${JSON.stringify(created)}`);
  const activated = await activateSavedVehicle(token, created.id);
  if (!activated.ok) throw new Error(`activate failed: ${JSON.stringify(activated)}`);

  console.log(JSON.stringify({ token, userId: user.id, garageId: created.id, phone }));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
