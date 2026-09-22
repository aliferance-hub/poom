import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { normalizeFa } from "@/lib/persian";
import { normalizeIdentifier } from "@/lib/catalog";
import {
  resolveFitmentFromRules,
  type FitmentResult,
  type VehicleContext,
  type FitmentRuleWithRefs,
} from "@/lib/fitment";

/**
 * ───────────────────────────── Search 2.0 (P2-C) ─────────────────────────────
 * Retrieval lives here; COMPATIBILITY never does. The provider batch-fetches
 * fitment rules for all candidates in ONE query and feeds them through
 * resolveFitmentFromRules — the exact same pure core resolveFitment uses.
 * There is no second compatibility algorithm anywhere.
 */

export type SearchSort = "RELEVANCE" | "PRICE_ASC" | "PRICE_DESC" | "NEWEST";

export type SearchInput = {
  query: string;
  vehicleContext?: VehicleContext | null;
  categoryId?: string;
  brandId?: string;
  compatibleOnly?: boolean;
  page?: number;
  pageSize?: number;
  sort?: SearchSort;
};

export type SearchHit = {
  part: {
    id: string;
    slug: string;
    title: string;
    sku: string;
    dataStatus: string;
    brandName: string | null;
    categoryTitle: string | null;
    categorySlug: string | null;
  };
  score: number;
  minPriceToman: number | null; // integer Toman (display unit), from IRR offers
  offerCount: number;
  fitment: FitmentResult | null; // null when no vehicle context supplied
};

export type SearchResult = {
  hits: SearchHit[];
  total: number;
  page: number;
  pageSize: number;
  NO_RESULTS: boolean;
  NO_COMPATIBLE_RESULTS: boolean; // context given + compatibleOnly + all candidates failed fitment
};

export interface SearchProvider {
  search(input: SearchInput): Promise<SearchResult>;
}

type Candidate = Prisma.PartGetPayload<{
  select: {
    id: true; slug: true; title: true; sku: true; dataStatus: true; createdAt: true;
    brand: { select: { name: true } };
    category: { select: { titleFa: true, slug: true } };
    offers: { select: { price: true }; orderBy: { price: "asc" } };
    identifiers: { select: { value: true } };
    fitments: { include: { variant: { select: { trim: true } }; vehicle: { select: { displayName: true } } } };
  };
}>;

const minPriceIrrOf = (c: Candidate): number | null => (c.offers.length > 0 ? c.offers[0]!.price : null);
const offerCountOf = (c: Candidate): number => c.offers.length;
const brandNameOf = (c: Candidate): string | null => c.brand?.name ?? null;
const categoryTitleOf = (c: Candidate): string | null => c.category?.titleFa ?? null;
const categorySlugOf = (c: Candidate): string | null => c.category?.slug ?? null;

const PAGE_DEFAULT = 24;
const PAGE_MAX = 60;

export class PostgresSearchProvider implements SearchProvider {
  async search(input: SearchInput): Promise<SearchResult> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(PAGE_MAX, Math.max(1, input.pageSize ?? PAGE_DEFAULT));
    const norm = normalizeFa(input.query ?? "");
    const terms = norm.split(" ").filter(Boolean);
    const idNorm = input.query ? normalizeIdentifier(input.query) : "";
    const ctx = input.vehicleContext ?? null;

    // ── Candidate selection (retrieval only — NOT compatibility) ──
    const where: Record<string, unknown> = { active: true };
    if (input.categoryId) where.categoryId = input.categoryId;
    if (input.brandId) where.brandId = input.brandId;
    // Vehicle used ONLY as a retrieval hint here (indexed candidate filtering);
    // the authoritative verdict comes from the engine below.
    if (ctx?.vehicleId && !input.compatibleOnly) where.fitments = { some: { vehicleId: ctx.vehicleId } };
    if (terms.length > 0) {
      where.OR = [
        { title: { contains: terms[0], mode: "insensitive" } },
        { titleEn: { contains: terms[0], mode: "insensitive" } }, // F3: Latin names
        { sku: { contains: terms[0], mode: "insensitive" } },
        { identifiers: { some: { value: { contains: terms[0], mode: "insensitive" } } } },
        { category: { titleFa: { contains: terms[0], mode: "insensitive" } } },
        { brand: { name: { contains: terms[0], mode: "insensitive" } } },
        { technicalDescription: { contains: terms[0], mode: "insensitive" } },
      ];
    }

    const candidates = await prisma.part.findMany({
      where,
      select: {
        id: true, slug: true, title: true, sku: true, dataStatus: true, createdAt: true, titleEn: true,
        brand: { select: { name: true } },
        category: { select: { titleFa: true, slug: true } },
        offers: { select: { price: true }, orderBy: { price: "asc" } },
        identifiers: { select: { value: true } },
        fitments: {
          // Batch fetch rules ONCE for every candidate with this vehicle —
          // resolveFitmentFromRules is pure, so this is 1 query total, no N+1.
          where: ctx?.vehicleId ? { vehicleId: ctx.vehicleId } : undefined,
          include: { variant: { select: { trim: true } }, vehicle: { select: { displayName: true } } },
        },
      },
      take: 300,
    });

    // ── Scoring (deterministic, explainable) ──
    type Scored = { c: Candidate; score: number; fitment: FitmentResult | null };
    const scored: Scored[] = [];
    for (const c of candidates) {
      let score = 0;
      const titleNorm = normalizeFa(c.title);
      const hay = normalizeFa(`${c.title} ${c.titleEn ?? ""} ${c.sku} ${c.category?.titleFa ?? ""} ${c.brand?.name ?? ""} ${c.identifiers.map((i) => i.value).join(" ")}`);
      const idHay = normalizeIdentifier(`${c.sku} ${c.identifiers.map((i) => i.value).join(" ")}`);
      // 1. exact identifier match (highest)
      if (idNorm && idHay === idNorm) score += 1000;
      else if (idNorm && idHay.includes(idNorm)) score += 400;
      // 2. exact title match
      if (norm && titleNorm === norm) score += 500;
      // 3. token matches (title tokens weigh double)
      for (const t of terms) {
        if (titleNorm.includes(t)) score += 2 * t.length * 10;
        else if (hay.includes(t)) score += t.length * 5;
      }
      if (score === 0 && terms.length > 0) continue;
      // 6. vehicle relevance
      if (ctx?.vehicleId && c.fitments.length > 0) score += 25;
      // offers with zero text match still surface for vehicle-only browse
      if (terms.length === 0 && ctx?.vehicleId && c.fitments.length === 0) continue;

      const fitment =
        ctx
          ? resolveFitmentFromRules(c.fitments as FitmentRuleWithRefs[], {
              vehicleId: ctx.vehicleId,
              variantId: ctx.variantId ?? null,
              engineId: ctx.engineId ?? null,
              transmissionId: ctx.transmissionId ?? null,
              engine: ctx.engine ?? null,
              transmission: ctx.transmission ?? null,
              bodyType: ctx.bodyType ?? null,
              year: ctx.year ?? null,
            })
          : null;

      if (input.compatibleOnly && ctx) {
        // Authoritative filter — from the ONE engine, never a local heuristic.
        if (fitment?.status !== "COMPATIBLE") continue;
      }
      scored.push({ c, score, fitment });
    }

    // Vehicle-aware prioritization: compatible first, then review, then unknown/
    // incompatible (hidden entirely when compatibleOnly). Within a group, rank score.
    const groupOf = (s: Scored): number => {
      if (!s.fitment) return 3; // no context → plain relevance group
      if (s.fitment.status === "COMPATIBLE") return 0;
      if (s.fitment.status === "REVIEW_REQUIRED") return 1;
      return 2; // INCOMPATIBLE — demoted, excluded when compatibleOnly
    };
    scored.sort((a, b) => {
      const g = groupOf(a) - groupOf(b);
      if (g !== 0) return g;
      if (input.sort === "PRICE_ASC" || input.sort === "PRICE_DESC") {
        const pa = minPriceIrrOf(a.c) ?? Number.MAX_SAFE_INTEGER;
        const pb = minPriceIrrOf(b.c) ?? Number.MAX_SAFE_INTEGER;
        const cmp = pa < pb ? -1 : pa > pb ? 1 : 0;
        return input.sort === "PRICE_ASC" ? cmp : -cmp;
      }
      if (input.sort === "NEWEST") return b.c.createdAt.getTime() - a.c.createdAt.getTime();
      // RELEVANCE (default): score desc, then title for stability
      if (a.score !== b.score) return b.score - a.score;
      return a.c.title < b.c.title ? -1 : 1;
    });

    // Incompatible results are hidden by default too (documented P2-C behavior:
    // compatible prioritized, review visible secondary, incompatible demoted to
    // tail unless compatibleOnly removed them entirely).
    const visible = input.compatibleOnly ? scored : scored.filter((s) => groupOf(s) !== 2).concat(scored.filter((s) => groupOf(s) === 2));
    const total = visible.length;
    const paged = visible.slice((page - 1) * pageSize, page * pageSize);

    const hits: SearchHit[] = paged.map(({ c, score, fitment }) => ({
      part: {
        id: c.id,
        slug: c.slug,
        title: c.title,
        sku: c.sku,
        dataStatus: c.dataStatus,
        brandName: brandNameOf(c),
        categoryTitle: categoryTitleOf(c),
        categorySlug: categorySlugOf(c),
      },
      score,
      minPriceToman: minPriceIrrOf(c) == null ? null : Math.round(minPriceIrrOf(c)! / 10), // IRR→Toman integer
      offerCount: offerCountOf(c),
      fitment,
    }));

    return {
      hits,
      total,
      page,
      pageSize,
      NO_RESULTS: total === 0,
      NO_COMPATIBLE_RESULTS: Boolean(ctx && input.compatibleOnly && total === 0 && candidates.length > 0),
    };
  }
}

/** Module-level default provider (swap point for future engines — never for logic). */
let provider: SearchProvider = new PostgresSearchProvider();
export function setSearchProvider(p: SearchProvider) {
  provider = p;
}
export async function searchParts2(input: SearchInput): Promise<SearchResult> {
  return provider.search(input);
}

// ───────────────────── Suggestions (autocomplete) ─────────────────────

export type Suggestions = {
  parts: { slug: string; title: string }[];
  categories: { slug: string; titleFa: string }[];
  brands: { slug: string | null; name: string }[];
  identifiers: { partSlug: string; value: string }[];
  vehicles: { slug: string; label: string }[];
};

export async function getSearchSuggestions(q: string): Promise<Suggestions> {
  const norm = normalizeFa(q);
  const idNorm = normalizeIdentifier(q);
  if (norm.length < 2 && idNorm.length < 2) {
    return { parts: [], categories: [], brands: [], identifiers: [], vehicles: [] };
  }
  const [parts, categories, brands, ids, vehicles] = await Promise.all([
    prisma.part.findMany({
      where: { active: true, OR: [{ title: { contains: norm, mode: "insensitive" } }, { sku: { contains: idNorm, mode: "insensitive" } }] },
      select: { slug: true, title: true },
      take: 6,
    }),
    prisma.category.findMany({
      where: { active: true, titleFa: { contains: norm, mode: "insensitive" } },
      select: { slug: true, titleFa: true },
      take: 4,
    }),
    prisma.brand.findMany({
      where: { active: true, name: { contains: norm, mode: "insensitive" } },
      select: { name: true, slug: true },
      take: 3,
    }),
    prisma.partIdentifier.findMany({
      where: { value: { contains: idNorm, mode: "insensitive" } },
      select: { value: true, part: { select: { slug: true } } },
      take: 4,
    }),
    prisma.vehicle.findMany({
      where: { active: true, OR: [{ displayName: { contains: norm, mode: "insensitive" } }, { make: { contains: norm, mode: "insensitive" } }, { model: { contains: norm, mode: "insensitive" } }] },
      select: { id: true, displayName: true, model: true, variants: { select: { id: true, trim: true }, take: 5 } },
      take: 3,
    }),
  ]);
  return {
    parts: parts.map((p) => ({ slug: p.slug, title: p.title })),
    categories: categories.map((c) => ({ slug: c.slug, titleFa: c.titleFa })),
    brands: brands.map((b) => ({ name: b.name, slug: b.slug })),
    identifiers: ids.map((i) => ({ value: i.value, partSlug: i.part.slug })),
    vehicles: vehicles.map((v) => ({ slug: v.id, label: v.displayName })),
  };
}
