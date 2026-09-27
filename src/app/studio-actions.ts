"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  promoteVersion,
  recordRenderVerification,
  refreshMappingHealth,
  rejectVersion,
  retireVersion,
  rollbackToVersion,
  stageVersion,
  storedAuditOf,
  validateVersion,
  type PromotionGate,
} from "@/lib/asset-registry";
import type { RenderVerification } from "@/lib/asset-lifecycle";
import { assertDemoTrust } from "@/lib/demo-trust"; // AUDIT FIX H2: admin session or explicit demo mode

const ACTOR = "admin:mapping-studio";

function vec3(input: unknown): [number, number, number] | null {
  if (Array.isArray(input) && input.length >= 3 && input.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return [input[0] as number, input[1] as number, input[2] as number];
  }
  return null;
}

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Assign a mesh to a zone/assembly/part (exactly one target enforced).
 *
 * P2-J (J12): when the selected version carries a measured inventory, the target
 * node must exist in it and must carry an AUTHORED name — otherwise the mapping
 * could not be rendered and would be a fiction. The node's structural
 * fingerprint is stored with the mapping so later drift is detectable (§27).
 */
export async function assignMeshAction(input: {
  versionId: string; meshName: string;
  kind: "zone" | "assembly" | "part";
  targetId: string; label?: string;
}): Promise<{ ok: boolean; error?: string; fingerprint?: string }> {
  await assertDemoTrust();

  const version = await prisma.assetVersion.findUnique({
    where: { id: input.versionId },
    select: { id: true, assetId: true, validationJson: true, state: true },
  });
  if (!version) return { ok: false, error: "VERSION_NOT_FOUND" };
  if (version.state === "PRODUCTION") {
    return { ok: false, error: "PRODUCTION_VERSION_IS_IMMUTABLE" }; // map on a new version instead
  }

  const audit = storedAuditOf(version.validationJson);
  const entries = audit?.inventory?.entries ?? null;
  let fingerprint: string | null = null;
  if (entries) {
    const hit =
      entries.find((e) => e.nodeName === input.meshName) ??
      entries.find((e) => sanitize(e.nodeName) === sanitize(input.meshName));
    if (!hit) return { ok: false, error: "NODE_NOT_IN_INVENTORY" };
    if (hit.nameSource !== "AUTHORED") return { ok: false, error: "NODE_NAME_NOT_AUTHORED" };
    fingerprint = hit.fingerprint;
  }

  const data =
    input.kind === "zone" ? { zoneId: input.targetId, assemblyId: null, partId: null } :
    input.kind === "assembly" ? { assemblyId: input.targetId, zoneId: null, partId: null } :
    { partId: input.targetId, zoneId: null, assemblyId: null };

  await prisma.meshMapping.upsert({
    where: { versionId_meshName: { versionId: input.versionId, meshName: input.meshName } },
    update: { kind: input.kind, ...data, label: input.label ?? null, meshFingerprint: fingerprint, mappingHealth: null, healthCheckedAt: null },
    create: {
      versionId: input.versionId, meshName: input.meshName, kind: input.kind, ...data,
      label: input.label ?? null, meshFingerprint: fingerprint,
    },
  });
  await prisma.assetEventLog.create({
    data: {
      assetId: version.assetId,
      versionId: version.id,
      event: "mapping_assigned",
      actor: ACTOR,
      note: `${input.meshName} → ${input.kind}`,
      detailJson: { meshName: input.meshName, kind: input.kind, targetId: input.targetId, fingerprint },
    },
  });
  await refreshMappingHealth(input.versionId, { actor: ACTOR });
  revalidatePath("/admin/assets");
  return { ok: true, fingerprint: fingerprint ?? undefined };
}

export async function unassignMeshAction(versionId: string, meshName: string) {
  await assertDemoTrust();
  const version = await prisma.assetVersion.findUnique({ where: { id: versionId }, select: { assetId: true, state: true } });
  if (version?.state === "PRODUCTION") return { ok: false, error: "PRODUCTION_VERSION_IS_IMMUTABLE" };
  const removed = await prisma.meshMapping.deleteMany({ where: { versionId, meshName } });
  if (version && removed.count > 0) {
    await prisma.assetEventLog.create({
      data: {
        assetId: version.assetId, versionId, event: "mapping_removed", actor: ACTOR,
        note: `mapping removed: ${meshName}`,
      },
    });
  }
  revalidatePath("/admin/assets");
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
  revalidatePath("/admin/assets");
  return { ok: true };
}

export async function refreshMappingHealthAction(versionId: string) {
  await assertDemoTrust();
  const res = await refreshMappingHealth(versionId, { actor: ACTOR });
  revalidatePath("/admin/assets");
  return res.ok ? { ok: true as const, rows: res.rows } : { ok: false as const, error: res.error };
}

export async function validateVersionAction(versionId: string) {
  await assertDemoTrust();
  const res = await validateVersion(versionId, { actor: ACTOR });
  revalidatePath("/admin/assets");
  return res.ok
    ? { ok: true as const, state: res.state }
    : { ok: false as const, error: res.error, problems: res.problems };
}

export async function stageVersionAction(versionId: string) {
  await assertDemoTrust();
  const res = await stageVersion(versionId, { actor: ACTOR });
  revalidatePath("/admin/assets");
  return res.ok
    ? { ok: true as const, mapping: res.mapping }
    : { ok: false as const, error: res.error, problems: res.problems };
}

/** Records real rendering evidence from Preview (J11/J34) → STAGED → VERIFIED. */
export async function recordVerificationAction(versionId: string, input: {
  url: string;
  viewports: string[];
  observations: string[];
  consoleErrors?: number;
  networkFailures?: number;
  webglErrors?: number;
}) {
  await assertDemoTrust();
  const verification: RenderVerification = {
    source: input.url.includes("localhost") || input.url.includes("127.0.0.1") ? "local-dev" : "preview",
    url: input.url,
    checkedAt: new Date().toISOString(),
    by: ACTOR,
    viewports: input.viewports.length > 0 ? input.viewports : ["desktop"],
    observations: input.observations.filter((o) => o.trim().length > 0),
    consoleErrors: input.consoleErrors,
    networkFailures: input.networkFailures,
    webglErrors: input.webglErrors,
  };
  const res = await recordRenderVerification(versionId, verification, { actor: ACTOR });
  revalidatePath("/admin/assets");
  return res.ok ? { ok: true as const, state: res.state } : { ok: false as const, error: res.error };
}

export type PromotionActionResult =
  | { ok: true; gates: PromotionGate[]; retiredPrevious: number | null }
  | { ok: false; error: string; problems: string[] };

export async function promoteVersionAction(versionId: string, note: string): Promise<PromotionActionResult> {
  await assertDemoTrust();
  const res = await promoteVersion(versionId, { actor: ACTOR, note });
  revalidatePath("/admin/assets");
  return res.ok
    ? { ok: true, gates: res.gates, retiredPrevious: res.retiredPrevious }
    : { ok: false, error: res.error, problems: res.problems ?? [] };
}

export async function rollbackVersionAction(versionId: string, reason: string): Promise<PromotionActionResult> {
  await assertDemoTrust();
  const res = await rollbackToVersion(versionId, { actor: ACTOR, reason: reason || "manual rollback" });
  revalidatePath("/admin/assets");
  return res.ok
    ? { ok: true, gates: res.gates, retiredPrevious: res.retiredPrevious }
    : { ok: false, error: res.error, problems: res.problems ?? [] };
}

export async function retireVersionAction(versionId: string, reason: string) {
  await assertDemoTrust();
  const res = await retireVersion(versionId, { actor: ACTOR, reason: reason || "manual retire" });
  revalidatePath("/admin/assets");
  return res.ok ? { ok: true as const, state: res.state } : { ok: false as const, error: res.error };
}

export async function rejectVersionAction(versionId: string, reason: string) {
  await assertDemoTrust();
  const res = await rejectVersion(versionId, { actor: ACTOR, reason: reason || "manual reject" });
  revalidatePath("/admin/assets");
  return res.ok ? { ok: true as const, state: res.state } : { ok: false as const, error: res.error };
}
