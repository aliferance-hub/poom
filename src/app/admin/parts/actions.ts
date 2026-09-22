"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { assertDemoTrust } from "@/lib/demo-trust";

export async function prismaTogglePartActive(partId: string, active: boolean) {
  await assertDemoTrust();
  await prisma.part.update({ where: { id: partId }, data: { active } });
  revalidatePath("/admin/parts");
  revalidatePath(`/parts`);
  return { ok: true as const };
}
