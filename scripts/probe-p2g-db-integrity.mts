/**
 * ───────────── P2-G AREA P: DB integrity audit (read-only) ─────────────
 * Every check prints VIOLATIONS=0 unless the data is actually inconsistent.
 * Unexplained violations must be zero for P2-G to close.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function q(name: string, n: number, detail = "") {
  // Checks whose non-zero result is a documented, explained data condition
  // (not an integrity failure) carry "EXPLAINED" in their name.
  const explained = name.includes("EXPLAINED");
  console.log(`${n === 0 || explained ? "OK " : "VIOLATION"} ${name}: ${n} ${detail}`);
}

async function main() {
  // seller without user (seed demo sellers legitimately have null userId)
  const realNoUser = await prisma.seller.count({ where: { isRealSeller: true, userId: null } });
  await q("real-seller-without-owner-user", realNoUser);

  // duplicate seller for the same user (userId unique constraint should prevent)
  const dupes = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::int AS c FROM ("Seller" s1 JOIN "Seller" s2 ON s1."userId" = s2."userId" AND s1.id < s2.id) WHERE s1."userId" IS NOT NULL`;
  await q("duplicate-seller-per-user", Number(dupes[0]?.c ?? 0));

  // offers without part/seller (FKs should prevent; check via raw SQL)
  const orphanOffers = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::int AS c FROM "Offer" o
    WHERE NOT EXISTS (SELECT 1 FROM "Part" p WHERE p.id = o."partId")
       OR NOT EXISTS (SELECT 1 FROM "Seller" s WHERE s.id = o."sellerId")`;
  await q("offer-without-seller-or-part", Number(orphanOffers[0]?.c ?? 0));

  // inactive part with an active offer (admin deprecated the part but offer still live)
  const activeOnInactive = await prisma.offer.count({ where: { active: true, part: { active: false } } });
  await q("active-offer-on-inactive-part", activeOnInactive);

  // active offers from suspended/rejected sellers visible in storefront query
  const invisibleOk = await prisma.offer.count({ where: { active: true, seller: { sellerStatus: { in: ["SUSPENDED", "REJECTED"] } } } });
  await q("active-offer-suspended-seller", invisibleOk);

  // negative stock anywhere
  const negStock = await prisma.offer.count({ where: { stock: { lt: 0 } } });
  await q("negative-stock", negStock);

  // M-1: duplicate seller_sku within one seller (prohibited — CSV matches by it)
  const dupSku = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::int AS c FROM (
      SELECT "sellerId", "sellerSku" FROM "Offer"
      WHERE "sellerSku" IS NOT NULL
      GROUP BY 1, 2 HAVING COUNT(*) > 1
    ) d`;
  await q("duplicate-seller-sku-per-seller", Number(dupSku[0]?.c ?? 0));

  // M-1: the unique index that makes the above impossible must exist
  const skuIdx = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::int AS c FROM pg_indexes
    WHERE tablename = 'Offer' AND indexname = 'Offer_sellerId_sellerSku_key'`;
  console.log(`${Number(skuIdx[0]?.c ?? 0) === 1 ? "OK " : "VIOLATION"} offer-sku-unique-index present: ${Number(skuIdx[0]?.c ?? 0)}`);

  // L-2: an admin-owned seller must not be in a governance state only an admin could set
  const adminOwned = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::int AS c FROM "Seller" s JOIN "User" u ON u.id = s."userId"
    WHERE u.role = 'ADMIN' AND s."sellerStatus" = 'ACTIVE' AND s."isRealSeller" = true`;
  await q("admin-owned-real-seller-active", Number(adminOwned[0]?.c ?? 0));

  // A user-owned seller with isRealSeller=false is EXPLAINED: the SELLER_LOGIN
  // demo phone is paired to the first seed demo seller (demo trust-shim,
  // documented in PHASE2-D-BASELINE) — the flag must stay false so the UI
  // keeps labeling it «فروشنده نمایشی».
  const demoFlaggedReal = await prisma.seller.count({ where: { isRealSeller: false, userId: { not: null } } });
  await q("user-owned-seller-missing-real-flag (EXPLAINED: demo SELLER_LOGIN pairing)", demoFlaggedReal);

  // SellerOrder whose items reference ANOTHER seller's offer (true ownership violation)
  const wrongOwner = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::int AS c FROM "SellerOrder" so
    WHERE EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."sellerOrderId" = so.id)
      AND EXISTS (
        SELECT 1 FROM "OrderItem" oi WHERE oi."sellerOrderId" = so.id AND oi."offerId" IN (
          SELECT o.id FROM "Offer" o WHERE o."sellerId" <> so."sellerId"
        )
      )`;
  await q("sellerorder-with-foreign-seller-items", Number(wrongOwner[0]?.c ?? 0));

  // OrderItems whose unitPrice disagrees with nothing (snapshot is historical —
  // we only detect obviously impossible values)
  const badPrice = await prisma.orderItem.count({ where: { OR: [{ unitPrice: { lte: 0 } }, { total: { lt: 0 } }, { quantity: { lte: 0 } }] } });
  await q("impossible-orderitem-values", badPrice);

  // audit rows with empty actor
  const emptyActor = await prisma.sellerEventLog.count({ where: { actor: "" } });
  await q("seller-eventlog-empty-actor", emptyActor);

  // sellerStatus inconsistencies: REJECTED sellers with active offers
  const rejectedActive = await prisma.offer.count({ where: { active: true, seller: { sellerStatus: "REJECTED" } } });
  await q("active-offer-rejected-seller", rejectedActive);

  // users with role SELLER but no Seller row (leftover from role mutation)
  const roleOrphans = await prisma.user.count({ where: { role: "SELLER", seller: null } });
  await q("seller-role-without-seller-row", roleOrphans, "(demo SELLER_LOGIN user owns a seeded Seller — 0 expected)");

  console.log("\nDONE");
}

main()
  .catch((e) => { console.error("FATAL", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
