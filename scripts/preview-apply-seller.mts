// P2-G preview walkthrough helper: apply a real seller through the lib path
// (the exact code the /seller/apply form calls). Usage:
//   npx tsx scripts/preview-apply-seller.mts <phone>
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const phone = process.argv[2]!;
let user = await prisma.user.findUnique({ where: { phone } });
if (!user) user = await prisma.user.create({ data: { phone, role: "CUSTOMER" } });
const existing = await prisma.seller.findUnique({ where: { userId: user.id } });
if (!existing) {
  const { applyAsSeller } = await import("../src/lib/seller/seller-onboarding");
  const r = await applyAsSeller(user.id, {
    businessName: "لوازم یدکی البرز (واقعی)",
    city: "کرج",
    ownerName: "مدیر فروشگاه البرز",
  });
  console.log(JSON.stringify(r));
} else {
  console.log(JSON.stringify({ ok: true, sellerId: existing.id, sellerStatus: existing.sellerStatus, note: "already applied" }));
}
await prisma.$disconnect();
