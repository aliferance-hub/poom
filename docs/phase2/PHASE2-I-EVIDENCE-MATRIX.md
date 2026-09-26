# P2-I — Evidence Matrix (Gates I1 + I2 + I3)

Date: 2026-09-27 · Auditor actor: `p2i-evidence-audit` (CatalogEventLog)
Method: field-level evidence review. A source proving one claim (e.g. "this is
a radiator for the 206") does NOT validate other claims (OEM number, brand,
year range, engine). Web evidence gathered 2026-09-26/27 via independent
aftermarket catalog indexes (OE-number and cross-reference listings).

Legend: ✔ supported by evidence · ✖ contradicted / unconfirmable · ? unknown (no evidence either way)

## I1 — Per-record evidence matrix

Common facts for all 12 records (sourceRef `public-206-maintenance-documentation`,
sourceUrl `https://example.org/evidence` — a placeholder, NOT a real source):
what the part is (identity by part name) is plausible; the vehicle family
(Peugeot 206, TU petrol engines) is common knowledge. Everything more specific
(OE numbers, brand, years, exact engine/variant) needs its own evidence.

| SKU | Part (identity) | OE number | Brand | Fitment family | Technical specs | Verification decision |
| --- | --- | --- | --- | --- | --- | --- |
| 206-RAD-001 | radiator assembly | ? (none recorded) | ✖ unsourced | ✔ generic family-level (maintenance part; both trims plausible) | ? none recorded | REVIEW_REQUIRED |
| 206-FAN-001 | radiator fan | ? | ✖ | ? (generic claim only) | ? | REVIEW_REQUIRED |
| 206-THR-001 | thermostat | ? | ✖ | ? (opening temp unknown) | ? | REVIEW_REQUIRED |
| 206-WPM-001 | water pump | ? | ✖ | ? | ? | REVIEW_REQUIRED |
| 206-OFL-001 | oil filter | ✖ `1109.AX` unconfirmable (see below) | ✖ | ✔ TU-family spin-on (MANN W712/75-class cross-refs) | ? | REVIEW_REQUIRED |
| 206-AFL-001 | air filter | ? | ✖ | ? (panel type plausible) | ? | REVIEW_REQUIRED |
| 206-TMB-001 | timing belt | ? | ✖ | ? (TU3/TU5 quoted, unproven) | ? | REVIEW_REQUIRED |
| 206-HGS-001 | head gasket | ? | ✖ | ✔ TU3 vs TU5 differ (independent sources list distinct gaskets per engine; negative rule justified) | ? | REVIEW_REQUIRED |
| 206-BPF-001 | front brake pad | ? | ✖ | ? (ceramic-organic claim unproven) | ? | REVIEW_REQUIRED |
| 206-BDF-001 | front brake disc | ? | ✖ | ? (diameter unproven) | ? | REVIEW_REQUIRED |
| 206-SHF-001 | front shock absorber | ? | ✖ | ? (gas claim unproven) | ? | REVIEW_REQUIRED |
| 206-ALT-001 | alternator | ? | ✖ | ? ("70 A" unproven) | ? | REVIEW_REQUIRED |

### The `1109.AX` finding (evidence-level, acted upon)

- Recorded in DB (and previously in seed/tests) as `OEM 1109.AX` for the oil filter.
- Independent cross-reference indexes (filong, highfil product listings) associate
  `1109.AX` / `1109ax` with the **Boxer-class W9142** filter family — not the 206's
  TU-family spin-on filter.
- Independent OE listings (spareto `1109a9`; trodo/ebay QFL0271 cross refs) show
  `1109 A9` (also written `1109.A9`) as the PSA TU-family **oil filter OE**, with
  TU-era 206 oil filters cross-referencing to MANN `W712/75` / `W712/47` families.
- Direct quoted-source check for `1109.AX` on a 206: **no source found**.
- Decision: the identifier could not be confirmed ⇒ **removed** (never promoted),
  seed no longer plants it, tests now assert NO unverified OE identifiers exist.
  A future OE number may only be attached with a real citable source.

### Brand «تولیدی ایران» finding

- Attributed to all 12 records by the original P2-F CSV, but no source in the
  provenance chain names an actual manufacturer. "Generic Iranian aftermarket"
  is not a manufacturer identity.
- Decision: **brandId cleared on all 12 records** (dataVersion bumped,
  CatalogEventLog rows written). Records stay REVIEW_REQUIRED.

## I2 — Fitment truth review

Current rules on the 12 records (all note-cited to the source ref):

- 11 × vehicle-level CONFIRMED (all 206 variants), head gasket: CONFIRMED for
  تیپ ۲ (TU3) + explicit REJECTED for تیپ ۵ (TU5).
- Presentation layer (`fitmentPresentation`) already downgrades a COMPATIBLE
  verdict to REVIEW_REQUIRED while the record is not VERIFIED/DEMO — customer
  never sees guaranteed-compatibility language on these records today. ✔
- Engine labels in DB carry a DEMO suffix (`TU3 (DEMO)`, `TU5 (DEMO)`) — the
  engine names themselves are common knowledge for the 206 family; the suffix
  marks the seeded variant rows, not fabricated engines. Kept.
- The head-gasket negative rule is evidence-supported (independent sources list
  distinct gaskets for TU3 1.4 vs TU5 1.6) and is the *strongest* claim these
  records carry — it stays.
- The 11 family-wide CONFIRMED rules are "plausible but unproven at
  variant/engine/year level". They remain vehicle-level (no invented year
  ranges/engines), and their presentation is gated by the record state. Kept
  narrowly; will be revisited per-part when per-part sources exist.

Conclusion: no fitment row overstates what evidence + presentation policy
support. No fitment rows needed removal; none may be strengthened.

## I3 — Verification decisions (decision engine applied)

- `verifyRealPart()` hardened (P2-I I4): evidence URL is now REQUIRED, DEMO
  records can never be verified, provenance (sourceRef) must exist, every
  attempt is audited in `CatalogEventLog` (including refusals and repeats).
- `reopenVerification()` no longer erases history (log-first design).
- Applied per record: **0 of 12 become VERIFIED** — per-record evidence is
  insufficient for the identity+OE+brand+fitment claims a PDP displays
  (the only OE number on file was actively discredited; brand attribution is
  unsourced). 12 × REVIEW_REQUIRED is the truthful outcome of this audit.
- REJECTED: none (nothing is contradicted at the identity level; only the
  `1109.AX` identifier was contradicted and it was removed rather than
  rejecting the record).

## Evidence gaps blocking verification (per record)

For every record, verification needs at minimum:
1. a real citable source URL replacing the `https://example.org/evidence`
   placeholder (P2-F carried it as scaffolding — it proves nothing);
2. OE/manufacturer identity (or an explicit decision to sell unbranded parts
   with no OE claim);
3. for any variant/engine-level compatibility claim: a source naming that
   variant/engine/years explicitly.

These gaps are the honest reason the catalog stays REVIEW_REQUIRED after P2-I.
