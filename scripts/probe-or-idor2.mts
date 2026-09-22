// Variant: attacker IS a logged-in user (userId set) whose uid differs — does
// OR-collapse with defined-but-unmatched userId still leak? Also: attacker has
// BOTH an unrelated session AND userId -> still safe? (expect SAFE both)
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const victim = await prisma.user.create({ data: { phone: `0913${Date.now()%100000000}`, role: "CUSTOMER", status: "ACTIVE" } });
const order = await prisma.order.create({ data: { orderNumber: `PROBE2-${Date.now()}`, userId: victim.id, sessionId: "victim-session", status: "PAID", paymentStatus: "SUCCEEDED", total: 1 } });
const found = await prisma.order.findFirst({ where: { id: order.id, OR: [{ sessionId: "attacker-session" }, { userId: "attacker-user-id" }] } });
console.log("USER_IDOR:", found ? "VULNERABLE" : "SAFE");
await prisma.order.delete({ where: { id: order.id } });
await prisma.user.delete({ where: { id: victim.id } });
