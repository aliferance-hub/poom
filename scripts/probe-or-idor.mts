// Adversarial probe: does Prisma OR-collapse let a GUEST (user=undefined,
// sessionId=guestA) read a customer-account-owned order (userId set, different session)?
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const uid = `probe-user-${Date.now()}`;
const user = await prisma.user.create({ data: { phone: `0912${Date.now()%100000000}`, role: "CUSTOMER", status: "ACTIVE" } });
const order = await prisma.order.create({ data: { orderNumber: `PROBE-${Date.now()}`, userId: user.id, sessionId: "victim-session", status: "PAID", paymentStatus: "SUCCEEDED", total: 1 } });
// attacker: undefined userId, unrelated sid — mirrors getCustomerOrder(owner, orderId) with user==null
const attackerOwner: { sessionId: string; userId?: string } = { sessionId: "attacker-session" };
const found = await prisma.order.findFirst({ where: { id: order.id, OR: [{ sessionId: attackerOwner.sessionId }, { userId: attackerOwner.userId }] } });
console.log("GUEST_IDOR:", found ? "VULNERABLE" : "SAFE");
// cleanup
await prisma.order.delete({ where: { id: order.id } });
await prisma.user.delete({ where: { id: user.id } });
