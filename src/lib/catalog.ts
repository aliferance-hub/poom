import { prisma } from "@/lib/prisma";
import { normalizeFa } from "@/lib/persian";

/**
 * Two normalization strategies (P2-B):
 *  - text: aggressive Persian normalization for titles/descriptions
 *  - identifier: conservative — uppercase, unify separators, Persian→English digits
 *    ONLY; never collapses letters, so DEMO-206-001 / ABC-206 / ABC/206 / MPN 206-01
 *    all stay searchable and distinct.
 */
export function normalizeIdentifier(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[\s\/_\.]+/g, "-")
    .toUpperCase()
    .trim();
}

export async function getVehicleWithVariants(make: string, model: string) {
  return prisma.vehicle.findFirst({
    where: { make: { equals: make, mode: "insensitive" }, model: { equals: model, mode: "insensitive" }, active: true },
    include: { variants: true },
  });
}

export async function getZonesForVehicle(vehicleId: string) {
  return prisma.vehicleZone.findMany({
    where: { vehicleId },
    orderBy: { sortOrder: "asc" },
    include: { _count: { select: { assemblies: true } } },
  });
}

export async function getZoneByKey(vehicleId: string, key: string) {
  return prisma.vehicleZone.findUnique({
    where: { vehicleId_key: { vehicleId, key } },
    include: {
      assemblies: { include: { _count: { select: { parts: true } } }, orderBy: { title: "asc" } },
    },
  });
}

export async function getAssemblyBySlug(slug: string) {
  return prisma.assembly.findUnique({
    where: { slug },
    include: {
      zone: true,
      parts: { orderBy: { title: "asc" } },
    },
  });
}

export async function getPartBySlug(slug: string) {
  return prisma.part.findUnique({
    where: { slug },
    include: {
      assembly: { include: { zone: true } },
      identifiers: true,
      fitments: { include: { vehicle: true, variant: true } },
      meshMappings: true,
      category: { include: { parent: true } },
      brand: true,
    },
  });
}

export async function searchParts(q: string, vehicleId?: string) {
  const norm = normalizeFa(q);
  if (!norm) return [];
  const terms = norm.split(" ").filter(Boolean);
  const parts = await prisma.part.findMany({
    where: vehicleId
      ? { fitments: { some: { vehicleId } } }
      : undefined,
    include: {
      assembly: { include: { zone: true } },
      fitments: { include: { vehicle: true, variant: true } },
      identifiers: true,
    },
    take: 200,
  });
  // Rank in memory on normalized text — dataset is tiny in MVP; move to DB-level
  // trigram/tsvector search when catalog grows.
  const scored = parts
    .map((p) => {
      const hay = normalizeFa(`${p.title} ${p.sku} ${p.slug} ${p.identifiers.map((i: { value: string }) => i.value).join(" ")}`);
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += t.length;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
  return scored.map((x) => x.p);
}

export async function listVehicles() {
  return prisma.vehicle.findMany({ where: { active: true }, include: { variants: true } });
}

// ───────────────── Categories (P2-B) ─────────────────

export type CategoryNode = {
  id: string; slug: string; titleFa: string; descriptionFa: string | null;
  sortOrder: number; children: CategoryNode[]; partCount: number;
};

/** Full active category tree with part counts (2 queries — no N+1). */
export async function getCategoryTree(): Promise<CategoryNode[]> {
  const [cats, counts] = await Promise.all([
    prisma.category.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { titleFa: "asc" }] }),
    prisma.part.groupBy({ by: ["categoryId"], where: { categoryId: { not: null } }, _count: { _all: true } }),
  ]);
  const countBy = new Map(counts.map((c) => [c.categoryId!, c._count._all]));
  const nodes = new Map<string, CategoryNode>(cats.map((c) => [c.id, {
    id: c.id, slug: c.slug, titleFa: c.titleFa, descriptionFa: c.descriptionFa,
    sortOrder: c.sortOrder, children: [], partCount: countBy.get(c.id) ?? 0,
  }]));
  const roots: CategoryNode[] = [];
  for (const c of cats) {
    const node = nodes.get(c.id)!;
    if (c.parentId && nodes.has(c.parentId)) nodes.get(c.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function getCategoryBySlug(slug: string) {
  return prisma.category.findUnique({
    where: { slug },
    include: {
      parent: true,
      children: { where: { active: true }, orderBy: { sortOrder: "asc" }, include: { _count: { select: { parts: true } } } },
    },
  });
}

/** Parts in this category AND its subtree (category pages include children). */
export async function getPartsForCategoryTree(categoryId: string, take = 80) {
  const ids = await prisma.category.findMany({ where: { OR: [{ id: categoryId }, { parentId: categoryId }] }, select: { id: true } });
  return prisma.part.findMany({
    where: { categoryId: { in: ids.map((c) => c.id) } },
    include: { brand: true, category: true, _count: { select: { offers: true } } },
    orderBy: { title: "asc" },
    take,
  });
}

// ───────────────── Related parts (P2-B) ─────────────────

export async function getRelatedParts(partId: string) {
  return prisma.relatedPart.findMany({
    where: { partId },
    include: { relatedPart: { include: { brand: true } } },
    orderBy: { type: "asc" },
  });
}

export const RELATED_TYPE_FA: Record<string, string> = {
  RELATED: "مرتبط",
  REPLACEMENT: "جایگزین",
  REQUIRES: "مکمل نصب",
  OFTEN_PURCHASED_WITH: "خرید همراه",
};

// ───────────────── Identifiers (P2-B) ─────────────────

export async function getPartIdentifiers(partId: string) {
  return prisma.partIdentifier.findMany({ where: { partId }, orderBy: { type: "asc" } });
}

/** Which other catalog numbers are associated with this part (cross references). */
export async function getCrossReferences(partId: string) {
  const xrefs = await prisma.partIdentifier.findMany({ where: { partId, type: "CROSS_REFERENCE" } });
  return xrefs;
}

export const IDENTIFIER_TYPE_FA: Record<string, string> = {
  OEM: "کد OEM",
  MPN: "کد سازنده",
  CROSS_REFERENCE: "کد معادل",
  GTIN: "GTIN",
  BARCODE: "بارکد",
  SELLER_SKU: "کد فروشنده",
};
