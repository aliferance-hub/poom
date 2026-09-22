// P2-D seed: pair demo sellers with login users (idempotent, run via `node prisma/seed-p2d-users.mjs`).
// Reads SELLER_LOGIN / ADMIN_LOGIN from .env (dotenv is already a transitive dep of prisma seed flow).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SELLER_LOGIN = process.env.SELLER_LOGIN ?? "09012345678";
const ADMIN_LOGIN = process.env.ADMIN_LOGIN ?? "09000000000";

async function upsertUser(phone, role) {
  return prisma.user.upsert({
    where: { phone },
    update: { role },
    create: { phone, role },
  });
}

async function main() {
  const sellerUser = await upsertUser(SELLER_LOGIN, "SELLER");
  const adminUser = await upsertUser(ADMIN_LOGIN, "ADMIN");

  // Pair the FIRST demo seller (فروشنده نمایشی ۱) with the seller login —
  // the other two remain unpaired so customer-facing offers keep working and
  // cross-seller isolation can be demonstrated in tests.
  const sellers = await prisma.seller.findMany({ orderBy: { businessName: "asc" } });
  if (sellers.length === 0) throw new Error("No sellers seeded — run the main seed first.");
  const first = sellers[0];
  // P2-G adversarial audit: a user-owned seller must keep isRealSeller=false
  // ONLY when it is actually a demo seed row. Pairing the SELLER_LOGIN demo
  // phone with the first demo seller is demo trust-shim territory, so the flag
  // stays false and the UI keeps labeling it «فروشنده نمایشی».
  await prisma.seller.update({ where: { id: first.id }, data: { userId: sellerUser.id, isRealSeller: first.isRealSeller ?? false } });

  console.log(
    JSON.stringify({
      sellerUser: sellerUser.phone,
      adminUser: adminUser.phone,
      pairedSeller: { id: first.id, businessName: first.businessName },
      unpairedSellers: sellers.slice(1).map((s) => s.businessName),
    }, null, 2),
  );
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
