import { prisma } from "@/lib/prisma";

/**
 * TEST-ONLY mirror of the P2-E identity resolution (cookies() is unavailable
 * outside a request scope). Mirrors the production rules exactly:
 *   SELLER: user active + role SELLER + Seller row + seller governance ACTIVE
 *   ADMIN:  user active + role ADMIN
 * Never imported by app code; asserted absent from route surfaces by tests.
 */
export async function getAuthenticatedSellerForTest(userId: string | null) {
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== "SELLER") return null;
  if (user.status === "SUSPENDED" || user.status === "DISABLED") return null;
  const seller = await prisma.seller.findUnique({ where: { userId: user.id } });
  if (!seller) return null;
  if (seller.sellerStatus === "SUSPENDED" || seller.sellerStatus === "REJECTED") return null;
  return { userId: user.id, role: "SELLER" as const, sellerId: seller.id };
}

export async function getAuthenticatedAdminForTest(userId: string | null) {
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== "ADMIN") return null;
  if (user.status === "SUSPENDED" || user.status === "DISABLED") return null;
  return { userId: user.id, role: "ADMIN" as const };
}
