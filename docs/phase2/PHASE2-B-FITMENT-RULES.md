# P2-B — Fitment Rules (normative)

This document is the human-readable spec of the **only** compatibility logic in POOM: `src/lib/fitment.ts → resolveFitment(partId, vehicleContext)`. No UI, 3D, search, or admin code may re-implement these rules.

---

## 1. Status semantics

| DB `fitmentStatus` | Engine result | Persian |
|---|---|---|
| `CONFIRMED` | `COMPATIBLE` | ✓ سازگار است |
| `PARTIAL` | `REVIEW_REQUIRED` | ? نیازمند بررسی |
| `PENDING_REVIEW` | `REVIEW_REQUIRED` | ? نیازمند بررسی |
| `REJECTED` | `INCOMPATIBLE` | ✕ ناسازگار است |
| *(no rule at all)* | `REVIEW_REQUIRED` | ? نیازمند بررسی |

**No silent downgrade.** Missing data is uncertainty (`REVIEW_REQUIRED`), never `COMPATIBLE`, never `INCOMPATIBLE`. Justification: absence of a fitment record means the catalog doesn't know — claiming "incompatible" would hide sellable parts; claiming "compatible" would lie. Both are worse than asking a human.

## 2. Precedence (most specific wins; deterministic)

Specificity level of a rule (higher wins):

| Level | Shape |
|---|---|
| 6 | variant + (engine ∨ transmission ∨ bodyType) + year range |
| 5 | variant + (engine ∨ transmission ∨ bodyType) |
| 4 | variant + year range |
| 3 | variant only |
| 2 | vehicle + year range |
| 1 | vehicle only |

Tie-breaks within a level: higher `yearFrom` first, then rule `id` (stable).

**Explicit negative always beats a less specific positive.** Example from seed: vehicle-level `CONFIRMED` (206) + variant-level `REJECTED` (تیپ ۵) ⇒ تیپ ۵ is `INCOMPATIBLE`; تیپ ۲ stays `COMPATIBLE`.

**Constraint semantics:** an `engine`/`transmission`/`bodyType` constraint is only evaluated when the caller supplies that context. Unknown context ≠ mismatch.

## 3. Year ranges (inclusive, open-ended, no calendar conversion)

- Both bounds inclusive: `yearFrom=2003, yearTo=2015` matches 2003 and 2015; 2016 fails.
- `yearFrom=null` → open-ended past; `yearTo=null` → open-ended future.
- **No year in context:** a range-constrained rule is *out of scope* (its condition cannot be evaluated), not auto-applicable. If no unscoped rule exists, the engine retries with the **rule-span mid-year** (mid of min `yearFrom` / max `yearTo` across the part's rules) so list/browse contexts get the least-surprising default; if rules disagree under that assumption, the result is `REVIEW_REQUIRED`.
- Calendar: demo data uses **Gregorian** (same as `VehicleVariant.productionStart`). Persian-calendar years (1388…) are *not* auto-converted and admin Zod year validation is deliberately unbounded — mixing calendars silently would corrupt fitment. Documented decision: convert once, centrally, in P2-C when a UI year picker exists.

## 4. Conflicts

- Same-specificity rules that disagree are resolved by **nesting**: a strictly narrower year range is *more restrictive* and wins (2003–2015 `CONFIRMED` + 2013–2015 `REJECTED` ⇒ INCOMPATIBLE inside 2013–2015, COMPATIBLE elsewhere).
- Disagreeing peers whose ranges are **not nested** (2003–2010 `CONFIRMED` vs 2008–2015 `REJECTED`) ⇒ `CONFLICTING_RULES` → `REVIEW_REQUIRED`, `conflicting: true`, surfaced to admin (and the DB `NULLS NOT DISTINCT` guard prevents the exact-duplicate variant of this).
- Conflict resolution never picks silently; it escalates.

## 5. Explainability contract

Every result carries:

```ts
type FitmentResult = {
  status: "COMPATIBLE" | "REVIEW_REQUIRED" | "INCOMPATIBLE";
  reason: string;        // machine: NO_FITMENT_DATA | RULE_MATCH:<id> | RULE_EXCLUDE:<id> | RULE_NEEDS_REVIEW:<id> | CONFLICTING_RULES | SPAN_RETRY:<id>
  reasonFa: string;      // Persian explanation shown verbatim in UI
  matchedRules: string[];// rule ids considered, most specific first
  bestRule | null;       // the winning rule (id/status/note/range)
  conflicting: boolean;  // admin escalation flag
};
```

The UI renders `reasonFa`, the winning rule's `fitmentNote`, vehicle/variant names and the year span — it never re-derives compatibility.

## 6. Worked examples (all covered by `tests/fitment-engine.test.ts`, cases A–J)

| Case | Setup | Query | Result |
|---|---|---|---|
| A | variant rule CONFIRMED | تیپ ۵ | COMPATIBLE |
| B | rule only on تیپ ۵ | تیپ ۲ | INCOMPATIBLE |
| C | PARTIAL on تیپ ۵ | تیپ ۵ | REVIEW_REQUIRED |
| D/E | range 2003–2015 | 2008 / 2016 | COMPATIBLE / INCOMPATIBLE |
| F | vehicle CONFIRMED + تیپ ۵ REJECTED | تیپ ۵ | INCOMPATIBLE (specific wins) |
| G | engine `TU5 (DEMO)` rule, ctx `TU1` | — | INCOMPATIBLE |
| H | transmission `MANUAL` rule, ctx `AUTOMATIC` | — | INCOMPATIBLE |
| I | `yearTo=null` open range | 2030 | COMPATIBLE |
| J | no rules | any | REVIEW_REQUIRED |
| K | nested negative 2003–15 CONF + 2013–15 REJ | 2008 / 2014 | COMPATIBLE / INCOMPATIBLE |
| L | no-year ctx vs ranged rules only | — | span-retry: COMPATIBLE |
| M | non-nested contradicting ranges | — | CONFLICTING_RULES → REVIEW_REQUIRED |
