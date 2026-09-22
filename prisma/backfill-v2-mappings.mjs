// One-shot backfill: version 1 → ACTIVE with MeshMapping rows derived from Phase-1 seed constants.
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const cam = {
  engine: [3.2, 2.4, 4.2], cooling: [2.6, 1.8, 3.4], brakes: [2.8, 1.2, 2.6], suspension: [2.4, 1.4, 3.0],
  wheels: [3.0, 1.2, 3.6], body: [0.5, 2.2, 5.2], electrical: [2.2, 2.0, 3.2], interior: [0.2, 1.8, 1.8],
};
const tgt = {
  engine: [0, 0.9, 1.6], cooling: [0, 0.9, 1.7], brakes: [0.9, 0.4, 1.6], suspension: [0.9, 0.4, 1.6],
  wheels: [1.0, 0.4, 0.9], body: [0, 0.8, 0], electrical: [0, 0.9, 1.5], interior: [0, 1.0, 0.2],
};
const hotspot = {
  'part_radiator_main': [0, 0.62, 1.62],
  'part_battery_main': [-0.45, 0.95, 1.2],
  'part_brake_pad_front_main': [0.62, 0.34, 1.15],
  'part_floor_mat_main': [0, 1.12, -0.35],
  'part_oil_filter_main': [0.62, 0.45, 1.3],
};

const asset = await p.asset.findUniqueOrThrow({ where: { assetId: 'peugeot-206-main-v1' } });
const v = await p.assetVersion.findUniqueOrThrow({ where: { assetId_version: { assetId: asset.id, version: 1 } } });

await p.assetVersion.update({
  where: { id: v.id },
  data: {
    status: 'ACTIVE', activatedAt: new Date(),
    licenseType: 'IN_REPO_DEMO', commercialUse: true, creator: 'POOM team (demo geometry)',
    attributionText: 'Placeholder primitives built in-repo — no third-party asset.',
  },
});

const zones = await p.vehicleZone.findMany({ where: { vehicleId: asset.vehicleId }, orderBy: { sortOrder: 'asc' } });
for (const z of zones) {
  await p.meshMapping.upsert({
    where: { versionId_meshName: { versionId: v.id, meshName: `zone_${z.key}` } },
    update: {},
    create: {
      versionId: v.id, meshName: `zone_${z.key}`, kind: 'zone', zoneId: z.id,
      label: z.title, sortOrder: z.sortOrder,
      cameraPositionJson: cam[z.key], cameraTargetJson: tgt[z.key],
      hotspotJson: z.key === 'cooling' ? [0, 0.62, 1.62] : null,
    },
  });
}

const pm = [
  ['part_radiator_main', 'radiator-206'],
  ['part_brake_pad_front_main', 'brake-pad-front-206'],
  ['part_oil_filter_main', 'oil-filter-206'],
  ['part_battery_main', 'battery-55ah'],
  ['part_floor_mat_main', 'floor-mat-set-206'],
];
for (const [mesh, slug] of pm) {
  const part = await p.part.findUnique({ where: { slug } });
  if (!part) { console.error('missing part', slug); continue; }
  await p.meshMapping.upsert({
    where: { versionId_meshName: { versionId: v.id, meshName: mesh } },
    update: {},
    create: { versionId: v.id, meshName: mesh, kind: 'part', partId: part.id, label: part.title, hotspotJson: hotspot[mesh] ?? null },
  });
}

const total = await p.meshMapping.count({ where: { versionId: v.id } });
const zoneCount = await p.meshMapping.count({ where: { versionId: v.id, kind: 'zone' } });
console.log(`backfilled ${total} mappings (${zoneCount} zones); version 1 ACTIVE`);
if (total !== 13 || zoneCount !== 8) { console.error('UNEXPECTED COUNTS'); process.exit(1); }
await p.$disconnect();
