import { prisma } from "@/lib/prisma";
import type { Fitment, Prisma } from "@prisma/client";

/** Fitment row plus the labels the engine needs for explanations (variant trim,
 *  vehicle displayName). This is the exact shape resolveFitment fetches; search
 *  batch-fetches the same shape and feeds the SAME pure resolver (no 2nd engine). */
export type FitmentRuleWithRefs = Prisma.FitmentGetPayload<{
  include: { variant: { select: { trim: true } }; vehicle: { select: { displayName: true } } };
}>;

/**
 * ───────────────────────── Fitment Engine 2.0 (P2-B) ─────────────────────────
 * The ONLY source of compatibility logic in POOM. UI, 3D flow, search and admin
 * all call resolveFitment — no component may duplicate these rules.
 *
 * Precedence (most specific wins, deterministic):
 *   1. variant + engine/transmission/bodyType constraint + year range
 *   2. variant + year range
 *   3. variant (no year)
 *   4. vehicle + year range
 *   5. vehicle (no year)
 *   6. no rule → REVIEW_REQUIRED (uncertainty stays uncertainty — never INCOMPATIBLE)
 * A more specific REJECTED rule always beats a less specific CONFIRMED rule
 * (explicit negative fitment, e.g. "206 compatible / 206 Type 5 incompatible").
 * Engine/transmission/bodyType constraints only apply when the caller supplies
 * that context (unknown constraint ≠ mismatch).
 * Year ranges are inclusive and open-ended on a null boundary; demo data uses
 * the same Gregorian calendar as VehicleVariant.productionStart — no conversion.
 */

export type VehicleContext = {
  vehicleId: string;
  variantId?: string | null;
  engineId?: string | null; // reserved for normalized Engine entities (P2-C+)
  transmissionId?: string | null; // reserved
  engine?: string | null; // free-form engine label, e.g. "TU5 (DEMO)"
  transmission?: string | null;
  bodyType?: string | null;
  year?: number | null;
};

export type FitmentResult = {
  status: "COMPATIBLE" | "REVIEW_REQUIRED" | "INCOMPATIBLE";
  reason: string;
  reasonFa: string;
  matchedRules: string[]; // fitment ids, most specific first
  bestRule: Pick<Fitment, "id" | "fitmentStatus" | "fitmentNote" | "yearFrom" | "yearTo"> | null;
  conflicting: boolean; // true when same-specificity rules disagree (admin must resolve)
};

type Specificity = { level: number; rule: Fitment };

function specificity(rule: Fitment): number {
  // higher = more specific
  if (rule.variantId && (rule.engine || rule.transmission || rule.bodyType) && (rule.yearFrom !== null || rule.yearTo !== null)) return 6;
  if (rule.variantId && (rule.engine || rule.transmission || rule.bodyType)) return 5;
  if (rule.variantId && (rule.yearFrom !== null || rule.yearTo !== null)) return 4;
  if (rule.variantId) return 3;
  if (rule.yearFrom !== null || rule.yearTo !== null) return 2;
  return 1; // bare vehicle rule
}

function yearMatches(rule: Fitment, year?: number | null): boolean {
  if (year == null) {
    // No year in context: a range-constrained rule is OUT OF SCOPE (its condition
    // cannot be evaluated), while open rules always apply. This prevents a narrow
    // REJECTED range from winning over a wide CONFIRMED rule when the user simply
    // hasn't specified a year.
    return rule.yearFrom == null && rule.yearTo == null;
  }
  if (rule.yearFrom != null && year < rule.yearFrom) return false;
  if (rule.yearTo != null && year > rule.yearTo) return false;
  return true;
}

function constraintMatches(rule: Fitment, ctx: VehicleContext): boolean {
  if (rule.engine && ctx.engine != null && rule.engine !== ctx.engine) return false;
  if (rule.transmission && ctx.transmission != null && rule.transmission !== ctx.transmission) return false;
  if (rule.bodyType && ctx.bodyType != null && rule.bodyType !== ctx.bodyType) return false;
  return true;
}

/** rule applies to this context at all? */
function appliesTo(rule: Fitment, ctx: VehicleContext): boolean {
  if (rule.vehicleId !== ctx.vehicleId) return false;
  if (rule.variantId && rule.variantId !== (ctx.variantId ?? null)) return false;
  return yearMatches(rule, ctx.year) && constraintMatches(rule, ctx);
}

function statusOf(rule: Fitment): FitmentResult["status"] {
  switch (rule.fitmentStatus) {
    case "CONFIRMED": return "COMPATIBLE";
    case "REJECTED": return "INCOMPATIBLE";
    default: return "REVIEW_REQUIRED"; // PARTIAL + PENDING_REVIEW
  }
}

/**
 * PURE decision core — the single compatibility algorithm. resolveFitment wraps
 * it with a DB fetch; the search provider batch-fetches rules for many parts in
 * one query and calls this for each candidate. All rules live here.
 */
export function resolveFitmentFromRules(rules: FitmentRuleWithRefs[], ctx: VehicleContext): FitmentResult {
  const notFound = (reasonFa: string): FitmentResult => ({
    status: "REVIEW_REQUIRED", reason: "NO_FITMENT_DATA", reasonFa, matchedRules: [], bestRule: null, conflicting: false,
  });

  const applicable = rules.filter((r) => appliesTo(r, ctx));

  // Case J — no rule touches this configuration. If the context lacks a year but
  // range rules exist, retry with the rule-span: a year between the overall min/max
  // is the least-surprising default for list/browse contexts (the part page passes
  // the variant's production mid-range). If still nothing applies → REVIEW_REQUIRED.
  if (applicable.length === 0 && ctx.year == null && rules.length > 0) {
    const lo = Math.min(...rules.map((r) => r.yearFrom ?? -Infinity));
    const hi = Math.max(...rules.map((r) => r.yearTo ?? Infinity));
    if (Number.isFinite(lo) || Number.isFinite(hi)) {
      const midYear = Number.isFinite(lo) && Number.isFinite(hi)
        ? Math.floor((lo + hi) / 2)
        : Number.isFinite(lo) ? lo + 1 : hi - 1;
      const retry = rules.filter((r) => yearMatches(r, midYear) && constraintMatches(r, ctx));
      if (retry.length > 0) {
        const verdicts = new Set(retry.map(statusOf));
        if (verdicts.size === 1) {
          const bestRetry = retry[0]!;
          const status = statusOf(bestRetry);
          return {
            status,
            reason: `RULE_${status === "COMPATIBLE" ? "MATCH" : status === "INCOMPATIBLE" ? "EXCLUDE" : "NEEDS_REVIEW"}:${bestRetry.id}`,
            reasonFa:
              status === "COMPATIBLE"
                ? `بر اساس بازه ثبت‌شده (${toFa(bestRetry.yearFrom)}–${toFa(bestRetry.yearTo)}) برای این خودرو سازگار است — سال دقیق خود را انتخاب کنید.`                  : status === "INCOMPATIBLE"
                  ? `بر اساس بازه‌های ثبت‌شده برای این خودرو سازگار نیست.`
                  : bestRetry.fitmentNote ?? "سازگاری این قطعه نیازمند بررسی کارشناس است.",
            matchedRules: retry.map((r) => r.id),
            bestRule: bestRetry,
            conflicting: false,
          };
        }
      }
    }
  }

  if (applicable.length === 0) {
    const anyForVehicle = rules.length > 0;
    return notFound(
      anyForVehicle
        ? "برای این قطعه و پیکربندی انتخابی شما قانون سازگاری ثبت نشده است."
        : "اطلاعات سازگاری این قطعه کامل نیست و نیاز به بررسی دارد.",
    );
  }

  // Deterministic order: most specific first, then most restrictive year, then id
  applicable.sort((a, b) => {
    const d = specificity(b) - specificity(a);
    if (d !== 0) return d;
    const ya = (a.yearFrom ?? -Infinity), yb = (b.yearFrom ?? -Infinity);
    if (ya !== yb) return yb - ya;
    return a.id < b.id ? -1 : 1;
  });

  const best = applicable[0]!;
  const bestLevel = specificity(best);

  // Conflict detection among same-specificity peers:
  //   a strictly narrower year range is MORE restrictive → it beats a wider
  //   contradicting rule (e.g. 2003–2015 CONFIRMED + 2013–2015 REJECTED ⇒
  //   INCOMPATIBLE inside 2013–2015). True conflict = disagreeing peers whose
  //   ranges are NOT nested (e.g. 2003–2010 CONFIRMED vs 2008–2015 REJECTED).
  const peers = applicable.filter((r) => specificity(r) === bestLevel);
  const narrowerThan = (a: Fitment, b: Fitment) => {
    const af = a.yearFrom ?? -Infinity, at = a.yearTo ?? Infinity;
    const bf = b.yearFrom ?? -Infinity, bt = b.yearTo ?? Infinity;
    return af >= bf && at <= bt && !(af === bf && at === bt);
  };
  let pool = [...peers];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of pool) {
      const loses = pool.filter(
        (q) => q !== p && statusOf(q) !== statusOf(p) && narrowerThan(p, q),
      );
      if (loses.length > 0) {
        pool = pool.filter((q) => !loses.includes(q));
        changed = true;
      }
    }
  }
  const statuses = new Set(pool.map(statusOf));
  const conflicting = statuses.size > 1;

  if (conflicting) {
    return {
      status: "REVIEW_REQUIRED",
      reason: "CONFLICTING_RULES",
      reasonFa: "اطلاعات سازگاری متناقض است و نیاز به بررسی دارد.",
      matchedRules: peers.map((r) => r.id),
      bestRule: best,
      conflicting: true,
    };
  }
  const winner = pool.find((r) => r.id === best.id) ?? pool[0]!;

  const vehicleName = winner.vehicle?.displayName ?? "خودرو";
  const variantName = winner.variant?.trim ? ` ${winner.variant.trim}` : "";
  const yearPart = winner.yearFrom != null || winner.yearTo != null
    ? ` (${toFa(winner.yearFrom)}–${toFa(winner.yearTo)})` : "";
  const matchedRules = applicable.map((r) => r.id);

  switch (statusOf(winner)) {
    case "COMPATIBLE":
      return {
        status: "COMPATIBLE",
        reason: `RULE_MATCH:${winner.id}`,
        reasonFa: `بر اساس قانون ثبت‌شده برای ${vehicleName}${variantName}${yearPart} سازگار است.`,
        matchedRules, bestRule: winner, conflicting: false,
      };
    case "INCOMPATIBLE":
      return {
        status: "INCOMPATIBLE",
        reason: `RULE_EXCLUDE:${winner.id}`,
        reasonFa: `بر اساس قانون ثبت‌شده برای ${vehicleName}${variantName}${yearPart} سازگار نیست.`,
        matchedRules, bestRule: winner, conflicting: false,
      };
    default:
      return {
        status: "REVIEW_REQUIRED",
        reason: `RULE_NEEDS_REVIEW:${winner.id}`,
        reasonFa: winner.fitmentNote ?? "سازگاری این قطعه نیازمند بررسی کارشناس است.",
        matchedRules, bestRule: winner, conflicting: false,
      };
  }
}

/** DB-backed entry point — fetches rules for ONE part and defers to the pure core. */
export async function resolveFitment(partId: string, ctx: VehicleContext): Promise<FitmentResult> {
  const rules = await prisma.fitment.findMany({
    where: { partId, vehicleId: ctx.vehicleId },
    include: { variant: { select: { trim: true } }, vehicle: { select: { displayName: true } } },
  });
  return resolveFitmentFromRules(rules, ctx);
}

function toFa(n: number | null): string {
  if (n == null) return "∞";
  return String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
}

/** Convenience wrapper for list contexts: resolve one part against a context. */
export async function getFitmentForVehicle(partId: string, ctx: VehicleContext) {
  return resolveFitment(partId, ctx);
}

/** Status → Persian presentation (single source used by all UI). */
export const FITMENT_FA: Record<FitmentResult["status"], string> = {
  COMPATIBLE: "✓ سازگار است",
  REVIEW_REQUIRED: "? نیازمند بررسی",
  INCOMPATIBLE: "✕ ناسازگار است",
};

/**
 * P2-F.1 (§3) — presentation policy layered on the engine verdict.
 * The verdict itself is the ONLY compatibility algorithm; this decides how a
 * verdict may be PRESENTED given the catalog record's data status. A definitive
 * compatibility claim ("سازگار است") is never shown for a part whose catalog
 * data is not yet verified/demo — uncertainty must stay visible.
 * Returns `null` when no policy adjustment is needed.
 */
export function fitmentPresentation(
  status: FitmentResult["status"],
  partDataStatus: string | null | undefined,
): "COMPATIBLE" | "REVIEW_REQUIRED" | "INCOMPATIBLE" | null {
  if (status !== "COMPATIBLE") return null; // review/incompatible need no softening
  if (partDataStatus === "DEMO" || partDataStatus === "VERIFIED") return null; // deterministic
  return "REVIEW_REQUIRED"; // REVIEW_REQUIRED / UNVERIFIED / unknown ⇒ cannot claim definitive compatibility
}

export const FITMENT_BADGE: Record<FitmentResult["status"], string> = {
  COMPATIBLE: "bg-green-100 text-green-800",
  REVIEW_REQUIRED: "bg-amber-100 text-amber-800",
  INCOMPATIBLE: "bg-red-100 text-red-700",
};

/** Explanation shown when a COMPATIBLE verdict is softened for unverified catalog data. */
export const FITMENT_REVIEW_FA =
  "قانون سازگاری برای این خودرو با قطعه مطابقت دارد، اما داده‌ی کاتالوگ این قطعه هنوز توسط ادمین تأیید نشده است؛ تأیید نهایی نیازمند بررسی است.";

/**
 * P2-G audit fix (HIGH): the explanation shown beside a verdict must never be
 * STRONGER than the presented verdict. `resolveFitment().reasonFa` for a
 * COMPATIBLE result literally reads «… سازگار است.» — showing that sentence
 * under a REVIEW_REQUIRED badge is the exact definitive compatibility claim the
 * presentation policy exists to suppress. This keeps the two in lockstep; the
 * engine verdict remains the single compatibility authority.
 */
export function fitmentPresentationReason(
  status: FitmentResult["status"],
  partDataStatus: string | null | undefined,
  reasonFa: string,
): string {
  return fitmentPresentation(status, partDataStatus) === "REVIEW_REQUIRED" ? FITMENT_REVIEW_FA : reasonFa;
}
