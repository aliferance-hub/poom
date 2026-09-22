"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { activateVersion, rollbackToVersion, markProcessing, validateVersion } from "@/lib/asset-registry";
import { assertDemoTrust } from "@/lib/demo-trust"; // AUDIT FIX H2: admin session or explicit demo mode

function vec3(input: unknown): [number, number, number] | null {
  if (Array.isArray(input) && input.length >= 3 && input.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return [input[0] as number, input[1] as number, input[2] as number];
  }
  return null;
}

/** Assign a mesh to a zone/assembly/part (exactly one target enforced). */
export async function assignMeshAction(input: {
  versionId: string; meshName: string;
  kind: "zone" | "assembly" | "part";
  targetId: string; label?: string;
}) {
  await assertDemoTrust();
  const data =
    input.kind === "zone" ? { zoneId: input.targetId, assemblyId: null, partId: null } :
    input.kind === "assembly" ? { assemblyId: input.targetId, zoneId: null, partId: null } :
    { partId: input.targetId, zoneId: null, assemblyId: null };

  await prisma.meshMapping.upsert({
    where: { versionId_meshName: { versionId: input.versionId, meshName: input.meshName } },
    update: { kind: input.kind, ...data, label: input.label ?? null },
    create: { versionId: input.versionId, meshName: input.meshName, kind: input.kind, ...data, label: input.label ?? null },
  });
  return { ok: true };
  revalidatePath(`/admin/assets`);
  return { ok: true };
}

export async function unassignMeshAction(versionId: string, meshName: string) {
  await assertDemoTrust();
  await prisma.meshMapping.deleteMany({ where: { versionId, meshName } });
  revalidatePath(`/admin/assets`);
  return { ok: true };
}

export async function updateMappingMetaAction(input: {
  versionId: string; meshName: string;
  cameraPosition?: unknown; cameraTarget?: unknown;
  hotspot?: unknown; explodedOffset?: unknown; label?: string;
}) {
  await assertDemoTrust();
  const data: Record<string, unknown> = {};
  const cam = vec3(input.cameraPosition); if (cam) data.cameraPositionJson = cam;
  const tgt = vec3(input.cameraTarget); if (tgt) data.cameraTargetJson = tgt;
  const hot = vec3(input.hotspot); if (hot) data.hotspotJson = hot;
  const ex = vec3(input.explodedOffset); if (ex) data.explodedOffsetJson = ex;
  if (typeof input.label === "string") data.label = input.label.slice(0, 60);
  await prisma.meshMapping.updateMany({ where: { versionId: input.versionId, meshName: input.meshName }, data });
  revalidatePath(`/admin/assets`);
  return { ok: true };
}

export async function activateVersionAction(versionId: string): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  await assertDemoTrust();
  try {
    const v = await activateVersion(versionId);
    revalidatePath(`/admin/assets`);
    return { ok: true, version: v.version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "ACTIVATION_FAILED" };
  }
}

export async function rollbackVersionAction(versionId: string): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  await assertDemoTrust();
  try {
    const v = await rollbackToVersion(versionId);
    revalidatePath(`/admin/assets`);
    return { ok: true, version: v.version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "ROLLBACK_FAILED" };
  }
}

export async function processVersionAction(versionId: string): Promise<{ ok: true } | { ok: false; error?: string; problems?: string[] }> {
  await assertDemoTrust();
  try {
    await markProcessing(versionId);
    const result = await validateVersion(versionId);
    revalidatePath(`/admin/assets`);
    return result.ok ? { ok: true } : { ok: false, problems: result.problems };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "PROCESSING_FAILED" };
  }
}
