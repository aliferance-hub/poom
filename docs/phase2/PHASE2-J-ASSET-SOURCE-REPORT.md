# P2-J — ASSET SOURCE REPORT (J0 Acquisition Strategy + J1 Candidate Discovery)

Phase: Real Peugeot 206 GLB acquisition, validation, storage and 3D mapping.
Date of evidence capture: 2026-09-27.
Status at time of writing: **ACQUISITION PENDING AUTHORIZED DOWNLOAD** (see §7).
Scope guard: this phase does not touch auth, payment, seller onboarding, backups/PITR,
region migration, catalog expansion, VIN, AI, mobile, AR, or unrelated UI work.

---

## 1. What P2-J needs from a 3D asset (rights framework)

Before any file is downloaded or imported, the project needs a documented answer for
every one of these questions. A single "UNKNOWN" on commercial use, redistribution or
modification stops the asset from entering the production pipeline (§4 of the phase spec).

| Requirement | Why POOM needs it |
| --- | --- |
| Commercial use | POOM is a commercial marketplace; the asset is used inside a revenue-generating product |
| Modification | Optimization (mesh simplification, texture resize, material consolidation, format repack) is mandatory, so a NoDerivatives license is unusable |
| Redistribution | The GLB is delivered to end-user browsers from POOM's own storage; a "no redistribution / no resale of the files" term conflicts with that delivery model |
| Attribution | If the license requires credit, the credit must be renderable in the UI and recorded in the registry |
| Provenance (who/where/when) | Auditability: every asset version must answer "where did this come from and what may we do with it" |
| Immutability | Checksum + immutable versioned object key so a later swap is detectable |

Rights are the gate; visual quality is secondary. A beautiful model without rights is
not a candidate.

## 2. Accepted acquisition paths (ranked)

1. **Openly licensed model (CC0 / CC-BY / equivalent) with documented provenance and an
   authorized download channel.** CC-BY is usable for a commercial product provided
   attribution is honored and the license text/URL is recorded.
2. **Commercial royalty-free license** obtained with a purchase receipt naming the
   licensee. Requires a purchasing decision by the project owner (see §7).
3. **Manufacturer / brand-authorized asset** with written permission naming POOM.
4. **User-provided asset with documented permission** from the rights holder.

Any path must end in: original source URL, provider, creator, license id + license URL,
commercial-use status, redistribution status, modification status, attribution text,
download date, original filename, byte size, SHA-256.

## 3. Rejected source categories (policy)

These are rejected by policy, regardless of how good the geometry looks or how easily it
downloads — this is the "NO FAKE GLB" rule extended to rights:

- Game rips and console/PC game extractions (Assetto Corsa, rFactor, NFS, BeamNG, Forza,
  GTA/FiveM vehicle packs, mod sites). Extracted content carries the original publisher's
  rights, not the uploader's.
- Scraper/mirror "download free without registration" sites that re-host other people's
  models without stating the license, even when the underlying work may be CC-licensed.
  A mirror cannot be verified to be the same work, and the license chain is not
  documented by the rights holder.
- Sites whose terms prohibit redistribution or resale of the downloaded files when the
  asset is served to browsers from POOM's own storage.
- Sketchfab's own "Free Standard" license (restricted, non-CC) and any "editorial use
  only" / "personal use" listing.
- Generative-AI-produced "Peugeot 206" models: the phase forbids presenting a synthetic
  asset as the real one, and AI output carries unsettled rights provenance.
- STL print-only models of the 206 (badges, keychains, print figs): geometry is unsuitable
  for a vehicle viewer and the typical license is personal-use.
- **Our own synthetic geometry.** The existing `peugeot-206-engineering-v1.glb` remains a
  labeled placeholder for development only. It can never be promoted as the real asset
  (§22 placeholder transition; §3.1 NO FAKE GLB).

## 4. Required provenance record (per candidate, per version)

```text
asset identity      : human-readable identity of the asset as claimed by its source
source URL          : the page the file was obtained from (canonical source, not a mirror)
source provider     : platform/vendor that hosts and licenses the asset
creator/owner       : author or rights holder as stated by the source (UNKNOWN if absent)
license             : SPDX-style id + human name (e.g. CC-BY-4.0 / Creative Commons Attribution)
license URL         : canonical license text URL (e.g. https://creativecommons.org/licenses/by/4.0/)
commercial use      : YES / NO / UNKNOWN
redistribution      : YES / NO / UNKNOWN
modification        : YES / NO / UNKNOWN
attribution         : required? exact attribution string if prescribed
download date       : ISO date of acquisition
original filename   : filename as delivered by the source
file size           : bytes
SHA-256             : content hash of the stored raw file
```

Rule: a field that cannot be established stays **UNKNOWN**. Unknown never becomes a
plausible-looking guess, and UNKNOWN commercial-use or redistribution status is a hard
stop for production eligibility. These fields map onto `AssetVersion` provenance columns
(`licenseType`, `licenseUrl`, `sourceUrl`, `creator`, `attributionText`, `commercialUse`,
`acquiredAt`, `modifications`, `intendedUsage`) plus the validation metadata added in this
phase (see `PHASE2-J-ASSET-VALIDATION.md`).

## 5. Channels searched for candidates (2026-09-27)

| Channel | Method | Outcome |
| --- | --- | --- |
| Web search (Google via search API) | `"peugeot 206" 3d model` variants, license-focused queries | Sketchfab CC-BY candidates; paid/account-gated marketplaces; print sites; mirrors |
| Sketchfab public pages | direct page fetch of each candidate (title, license line, triangle/vertex counts, download status) | 6 candidates inspected; licences range CC-BY → "Free Standard" → undocumented |
| Sketchfab Data API | `api.sketchfab.com/v3/models/{uid}` | blocked for this host (HTTP 403 bot protection) → license evidence taken from the public model pages instead |
| GitHub API (authenticated) | repository search `peugeot 206 glb model`; code search `206 extension:glb` | no usable model repository (results unrelated: planets, avatars, cemetery scenes) |
| Wikimedia Commons API | file search `peugeot 206 STL` | no 3D vehicle models (photos only) |
| Internet Archive advancedsearch | `mediatype:(data OR software)` + `peugeot 206`; `peugeot AND gltf` | only keychains / a Scalextric chassis / a Winamp skin; no vehicle asset |
| Poly Pizza (CC-BY 3.0 archive of Google Poly) | search + tag page | no Peugeot/206 asset (404 on tag) |
| Marketplace listings (TurboSquid, CGTrader, Free3D.com, free3d.io, stlfinder, SketchUp Warehouse) | page inspection for license + download terms | all either paid, account-gated with undocumented rights, or redistribution-prohibited |

No acceptable candidate was reachable through an **unauthenticated, officially authorized**
download channel. The candidates in §6 are all legal for POOM's intended use, but the file
must be fetched by an authenticated human session (Sketchfab requires a logged-in account
to download, including for CC-BY models) or purchased.

## 6. J1 — Candidate comparison table

Identity here is **as claimed by the source**. Visual/geometry validation (gate J2/J3)
requires the actual file and is therefore not started; nothing below is treated as
confirmed Peugeot 206 identity.

| # | Candidate | Source | Vehicle identity (claimed) | License | Commercial use | Redistribution | Download access | Geometry (as listed) | Node/mesh quality (as listed) | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | "VEHICLE - PEUGEOT 206" (Thcyrax) | sketchfab `f342081c28304bf9a7c3322defc33e95` | Peugeot 206 hatchback, game-ready low poly | CC-BY (Creative Commons Attribution) | YES | YES (attribution) | Sketchfab account required | 5.4k tris / 2.9k verts; PNG 512×512 12-color atlas; 1 material | explicit: body and wheels in separate meshes → clean zone targets | ~~PREFERRED~~ → **REJECTED BY OWNER (2026-09-29)**: the visual model does not match the intended POOM experience; kept for audit only (see §6.1) |
| C2 | "Peugeot 206 GTI" (Cobalt Design) | sketchfab `b2ef11bf94b848618b5b7f38e202316b` | Peugeot 206 GTI (3-door hot hatch) | CC-BY | YES | YES | Sketchfab account required | 87.7k tris / 50.9k verts | unknown (no description) | **ACCEPTABLE** (mid-weight, better silhouette fidelity) |
| C3 | "Peugeot 206" (Alvier) | sketchfab `dc25a117378545e7a804c8594aa86938` | "peugeot 206 sport"; tags include `peugeot-206-wrc` → variant ambiguous | CC-BY | YES | YES | Sketchfab account required | 491.9k tris / 251.2k verts | unknown | **CONDITIONAL** (heavy; needs measured simplification; variant ambiguity must stay UNKNOWN) |
| C4 | "Peugeot 206 low poly" (Ed) | sketchfab `242e861b687c437eb84f9c240185ce2a` | Peugeot 206 low poly (mobile-game background asset) | CC-BY + NoAI clause (NoAI restricts AI datasets/shape-generators only; does not block commercial display) | YES | YES | Sketchfab account required | 5.6k tris / 2.8k verts | unknown | **BACKUP** |
| C5 | "Peugeot 206" (Mona x Supercars) | sketchfab `44ac8a85939f4e3089649d4712275886` | Peugeot 206 (no description) | CC Attribution (page evidence captured 2026-09-29) | YES | YES | Sketchfab account required | 171.9k tris / 93.1k verts | unknown (not stated on page) | **ACCEPTED** (see §6.1; suspected duplicate of C10) |
| C10 | "Peugeot-206" (bimboit34) | sketchfab `2a41b3b90a2f464192787d7a5567c04b` | Peugeot 206 ("Francia") | CC Attribution | YES | YES | Sketchfab account required | 171.9k tris / 93.1k verts; published 2023-01-10, 1.7k downloads | unknown | **ACCEPTED** (see §6.1; likely the original of the C5 pair) |
| C11 | "Peugeot 206 1999" (LEON elenaisakova248) | sketchfab `675fb6cd912f48e1a704bcc3e1142bb9` | Peugeot 206 1999 | CC Attribution | YES | YES | Sketchfab account required | 1.3k tris / 655 verts | unknown | **REJECTED** — below minimum visual fidelity for a customer-facing viewer |
| C12 | "Car Peugeot 206" (Jenny-KU) | sketchfab `60d229e76568425f98310f8edeb04f3b` | Peugeot 206 (student project) | **no license stated on page** | UNKNOWN | UNKNOWN | Sketchfab account required | 16.9k tris / 8.7k verts | unknown | **REJECTED** — license UNKNOWN (hard stop) |
| C13 | "Peugeot 206 WRC Photogrammetry" (ADM8 / wbelmovic) | sketchfab `36790f33bb054d5b912a6509c7e24594` | 206 WRC rally car (photogrammetry of a promotional display car) | CC Attribution-ShareAlike; flagged "contains promotional content" | YES (ShareAlike obligations) | YES (ShareAlike) | Sketchfab account required | 789k tris / 395.3k verts | photogrammetry scan | **REJECTED** — not a standard 206 hatchback; ShareAlike + promotional flag add obligations |
| C6 | "CAR-PEUGEOT 206" (Jelvehkar) | sketchfab `a266dc3ee2114ff4abdef0dcdcffbf8e` | Peugeot 206 | "Free Standard" (Sketchfab restricted license, not CC); model flagged "Generated with AI" | restricted | NO (license forbids redistribution of the asset) | Sketchfab account required | 453.1k tris / 235.3k verts | unknown | **REJECTED** — restricted license + AI-generated |
| C7 | "2004 - Peugeot 206 RC" (Free Vehicle Archive) | sketchfab `08499a4ed37444659b95630948e190d0` | Peugeot 206 RC (2004) | **no license stated**; distribution pushed to an external paid channel (Patreon) | UNKNOWN | UNKNOWN | external paid channel | 167.4k tris / 98.8k verts | unknown | **REJECTED** — license UNKNOWN (hard stop) |
| C8 | "Peugeot 206." (Igor Dimov, 2006) | free3d.io `ac2638db` | Peugeot 206 | site Terms of Use: free for personal/commercial *visualization*, "redistribution or resale of the files is not allowed" | YES (limited) | **NO** | direct, no registration | 797 KB; `.gsm/.obj/.3ds` (no glTF) — requires conversion | unknown | **REJECTED** — redistribution term conflicts with browser delivery; also a mirror of an undocumented original |
| C9 | Marketplace listings (TurboSquid / CGTrader / Free3D.com / free3d.io premium / SketchUp Warehouse) | various | mixed | mostly paid royalty-free; SketchUp Warehouse terms forbid commercial use of third-party models | purchase-dependent | purchase-dependent | account/purchase | varied | varied | **NOT ACQUIRED** — purchase is a project-owner decision (§7 path B) |

### Candidate notes and open risks

- C1–C4 all resolve to `https://creativecommons.org/licenses/by/4.0/` semantics:
  commercial use YES, modification YES, redistribution YES, attribution REQUIRED.
  Under this license the *work* may be redistributed by POOM; POOM must credit the
  creator and keep the license reference in the asset registry and in the viewer.
- Attribution strings will be derived from the creator's stated profile name and model
  title, and rendered in the viewer overlay (`contract.license.attributionText`) plus an
  attribution row in the mapping/validation reports. No attribution will be invented.
- C3's `peugeot-206-wrc` tag, C2's "GTI", and any claim about trim/engine will not be
  promoted to fact: gate J2 records only what the source establishes. A generic
  "Peugeot 206" identity is what may be recorded unless the file itself proves more.
- The NoAI clause on C4 is noted for the record: it restricts use as AI training data or
  as input to shape generators. POOM's use (display + optimization) is unaffected, and
  POOM has no AI features in scope.
- Nothing in this table claims the file contains an oil filter, radiator, radiator fan or
  any other specific part mesh. J10 starts from the measured node inventory, not from
  assumptions (see `PHASE2-J-MAPPING-REPORT.md`).

## 6.1 — J1 re-run (2026-09-29): owner rejected C1, fresh candidate sweep

The project owner reviewed C1 and **rejected it on visual fidelity**: the model does not
match the intended POOM experience. C1 stays in §6 for audit but is no longer a
candidate. A fresh sweep was run with the owner's priority order:

1. visual fidelity, 2. standard 206 hatchback appearance, 3. separate semantic
meshes/nodes, 4. interior/exterior completeness, 5. documented commercial-use license.

**New pages inspected (evidence captured 2026-09-29):**

- `sketchfab.com/3d-models/peugeot-206-2a41b3b90a2f464192787d7a5567c04b` → C10
  ("Peugeot-206" by bimboit34, CC Attribution, 171.9k tris / 93.1k verts, published
  2023-01-10, 1.7k downloads, no tags/description).
- `sketchfab.com/3d-models/peugeot-206-44ac8a85939f4e3089649d4712275886` → C5 page
  evidence finally captured: CC Attribution, 171.9k tris / 93.1k verts, published
  2024-01-24, 1.2k downloads, no description.
- `sketchfab.com/3d-models/peugeot-206-1999-675fb6cd912f48e1a704bcc3e1142bb9` → C11
  (CC Attribution but only 1.3k tris — rejected).
- `sketchfab.com/3d-models/car-peugeot-206-60d229e76568425f98310f8edeb04f3b` → C12
  (no license stated — rejected).
- `sketchfab.com/3d-models/peugeot-206-wrc-photogrammetry-3d-model-36790f33bb054d5b912a6509c7e24594`
  → C13 (CC-BY-SA photogrammetry of a WRC rally display car — rejected: not a standard
  hatchback; 789k tris; "promotional content" flag).
- CGTrader listings (`peugeot-206` free, `peugeot-206-hatchback-5-door`, detailed
  `$99` model with "18 objects, 6 groups, 14 V-Ray materials") → blocked from direct
  page fetch (HTTP 403); per §6 row C9 they are paid/account-gated and remain
  **NOT ACQUIRED** (a purchase is a project-owner decision, §7 Path B).
- Sketchfab tag page `/tags/206` is JS-rendered and yields no additional IDs.

**Duplicate-pair observation (recorded, not asserted as fact):** C5 and C10 list an
identical triangle/vertex count (171.9k / 93.1k) and near-identical titles; C5 was
published ~1 year after C10. The likeliest explanation is that one is a re-upload of
the other — only the actual files (J3 checksums, container inspection) can establish
this. Until then both stay separate candidates and neither identity claim is elevated.

**Honest limitation of J1:** Sketchfab pages do not state interior/exterior scope or
node/mesh naming; those can only be measured on the delivered file (J3/J5 inventory).
"Separate semantic meshes" and "interior/exterior completeness" below are therefore
evidence-based only where the page states it, and UNKNOWN otherwise.

**Refreshed shortlist (in owner-priority order):**

| Rank | Candidate | Why it ranks here | Open UNKNOWNs |
| --- | --- | --- | --- |
| 1 | **C10** bimboit34 `2a41b3b9…` CC-BY, 171.9k tris | high silhouette fidelity for a standard 206; largest download base (1.7k) suggests a complete, usable model; earlier publication (likely the original) | mesh/node split UNKNOWN; interior scope UNKNOWN; textures UNKNOWN |
| 2 | **C5** Mona x Supercars `44ac8a85…` CC-BY, 171.9k tris | same geometry signature as C10 (likely the same work); choose as fallback or tie-break once files are compared | same as C10; plus whether it is truly a distinct work |
| 3 | **C2** Cobalt Design `b2ef11bf…` CC-BY, 87.7k tris | "GTI" 3-door — GTI shares the standard 206 body shell; mid-weight and clean | whether the source visually distinguishes it enough for the owner; node split UNKNOWN |
| 4 | **C3** Alvier `dc25a117…` CC-BY, 491.9k tris | highest detail of the accepted set; "sport/WRC" tag keeps variant UNKNOWN | heavy (measured simplification mandatory); variant ambiguity stays UNKNOWN |
| 5 | **C4** Ed `242e861b…` CC-BY + NoAI, 5.6k tris | lightweight backup if the shortlist fails validation; NoAI clause does not affect POOM | low fidelity by design (mobile background asset) |

C1 is **removed from the shortlist** (owner rejection). If none of ranks 1–4 pass
J2/J3 on the delivered files, C4 is the last resort before reporting BLOCKED again.

## 7. Decision and resolution paths

**J0/J1 outcome (after the 2026-09-29 re-run): a rights-clean candidate set exists
(C2, C3, C4, C5, C10 — all Sketchfab CC-BY), but every one of them is reachable only
through an authenticated download at the source (Sketchfab requires a free logged-in
account even for CC-BY models). No file has been obtained yet, therefore J2 (identity),
J3 (file/GLB validation) and everything downstream are NOT STARTED.**

Resolution paths, in preference order:- **Path A — owner-authenticated download (preferred, no cost):** the project owner logs
  into Sketchfab and downloads one or more of the accepted candidates (C2, C3, C4, C5,
  C10) from the canonical model pages, then drops the files into
  `poom/.freebuff/asset-inbox/`. Everything after that point is automated by this phase's pipeline: checksum → provenance record → structural/security
  validation → node inventory → measured optimization → immutable versioned Supabase
  Storage upload → registry version → zone/part mapping → R3F render → promotion.
- **Path B — owner-authorized API fetch:** the owner places a Sketchfab access token in
  the gitignored `.freebuff/tokens.env`; the pipeline fetches the same canonical CC-BY
  models through Sketchfab's official download API. Same pipeline, same provenance rules.
- **Path C — owner-supplied licensed asset:** the owner provides their own file with its
  license documentation (or a purchased royalty-free asset's receipt).
- **Path D — proceed without a real asset:** the phase continues building and verifying
  the pipeline (validation, registry states, immutable storage, mapping safety,
  truthfulness UI) but the REAL GLB gate stays NO and the phase reports
  `P2-J STATUS: BLOCKED` with this exact blocker. The placeholder stays labeled as
  DEMO/PLACEHOLDER and is never presented as the real vehicle.

## 8. Placeholder rules while acquisition is pending

- The active asset version in every environment remains the labeled placeholder
  (`uploads/assets/peugeot-206-main-v1/v2/peugeot-206-engineering-v1.glb`,
  sha256 `39d3d9d534b2c1e41523492273c37d16380973b2d54dd63d19c593507dbd243f`).
- No production UI may claim a real vehicle model while this is the active version; the
  viewer keeps its "نمونهٔ جایگزین (asset واقعی ثبت نشده است)" line.
- The placeholder is never renamed, re-licensed, or uploaded under a key that implies a
  real Peugeot 206 source.
