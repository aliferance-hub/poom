// P2-J (J0/J1 + §5): the provenance record and its validation.
//
// A record is either complete or it stays out of the pipeline. UNKNOWN is a
// first-class value and an UNKNOWN right is never upgraded to YES by inference:
// that is the difference between a documented license and a wish.
import { Problem, problem } from "./types";

export type TriState = "YES" | "NO" | "UNKNOWN";

/** The mandated provenance record (§5). Missing values stay null / UNKNOWN. */
export type ProvenanceRecord = {
  /** What the asset claims to be, as evidenced by the source, e.g. "Peugeot 206". */
  assetIdentity: string;
  /** Page the file was obtained from — the canonical source, never a mirror. */
  sourceUrl: string;
  /** Platform / vendor that states the license, e.g. "Sketchfab". */
  sourceProvider: string;
  /** Author or rights holder as stated by the source (null = not stated). */
  creator: string | null;
  /** SPDX-style id, e.g. CC-BY-4.0. */
  licenseType: string;
  /** Canonical license text URL. */
  licenseUrl: string | null;
  commercialUse: TriState;
  redistributionAllowed: TriState;
  modificationAllowed: TriState;
  /** Credit string required to be shown to end users (when the license asks for it). */
  attributionText: string | null;
  /** ISO date of acquisition. */
  downloadDate: string;
  originalFilename: string;
  fileSize: number;
  sha256: string;
  /** Declared scope of use inside POOM, e.g. "product viewer". */
  intendedUsage: string;
  /** What was changed after acquisition (null = nothing declared). */
  modifications: string | null;
  /** Free-form notes: uncertainty, variant ambiguity, contact attempts, … */
  notes?: string | null;
  /** Optional variant claim (only when the source documents it). */
  variantClaim?: string | null;
};

export type RightsSummary = {
  commercialUse: TriState;
  redistribution: TriState;
  modification: TriState;
  attributionRequired: boolean;
  /** License family classification used by the promotion gate. */
  class: "OPEN_PERMISSIVE" | "OPEN_ATTRIBUTION" | "OPEN_SHARE_ALIKE" | "UNKNOWN" | "RESTRICTED";
};

export type ProvenanceCheck = {
  problems: Problem[];
  rights: RightsSummary;
  /** Nothing prevents ingestion into the local, non-public pipeline. */
  canIngest: boolean;
  /** Everything required before a version may be promoted to PRODUCTION. */
  canPromote: boolean;
};

const OPEN_LICENSES: Record<string, { attributionRequired: boolean; shareAlike: boolean }> = {
  "CC0-1.0": { attributionRequired: false, shareAlike: false },
  "CC0": { attributionRequired: false, shareAlike: false },
  "PUBLIC-DOMAIN": { attributionRequired: false, shareAlike: false },
  "CC-BY-4.0": { attributionRequired: true, shareAlike: false },
  "CC-BY-3.0": { attributionRequired: true, shareAlike: false },
  "CC-BY-2.5": { attributionRequired: true, shareAlike: false },
  "CC-BY-2.0": { attributionRequired: true, shareAlike: false },
  "CC-BY-SA-4.0": { attributionRequired: true, shareAlike: true },
  "CC-BY-SA-3.0": { attributionRequired: true, shareAlike: true },
  "MIT": { attributionRequired: true, shareAlike: false },
  "APACHE-2.0": { attributionRequired: true, shareAlike: false },
  "BSD-3-CLAUSE": { attributionRequired: true, shareAlike: false },
};

/** License ids that can never be used for a commercial marketplace asset. */
const RESTRICTED_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bNC\b|NONCOMMERCIAL|NON-COMMERCIAL/i, reason: "non-commercial license" },
  { re: /\bND\b|NODERIV|NO-DERIV/i, reason: "no-derivatives license" },
  { re: /EDITORIAL/i, reason: "editorial-use-only license" },
  { re: /PERSONAL/i, reason: "personal-use-only license" },
  { re: /FREE[-_ ]?STANDARD|SKETCHFAB[-_ ]?STANDARD/i, reason: "platform restricted license (no redistribution)" },
  { re: /UNSPECIFIED|UNKNOWN|TBD|NONE|N\/A|^$/i, reason: "license not stated" },
];

const PLACEHOLDER_HOSTS = [
  "example.com", "example.org", "example.net", "localhost", "test.com", "test.local",
  "invalid", "domain.invalid", "sketchfab.invalid",
];

function normalizeLicenseId(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "-");
  if (/CREATIVE[-_ ]?COMMONS|^CC[-_]/.test(s)) {
    const isCC0 = /^CC0/.test(s) || s.includes("CC0");
    if (isCC0) return "CC0-1.0";
    const parts: string[] = [];
    if (s.includes("BY") || /ATTRIBUTION/.test(s)) parts.push("BY");
    if (s.includes("SA")) parts.push("SA");
    if (s.includes("NC")) parts.push("NC");
    if (s.includes("ND")) parts.push("ND");
    const ver = /(\d\.\d)/.exec(s)?.[1];
    return `CC-${parts.join("-")}${ver ? `-${ver}` : ""}`;
  }
  return s;
}

function classifyLicense(raw: string): { id: string; rights: RightsSummary; problems: Problem[] } {
  const problems: Problem[] = [];
  const id = normalizeLicenseId(raw);
  for (const { re, reason } of RESTRICTED_PATTERNS) {
    if (re.test(id) || re.test(raw)) {
      const isUnknown = /UNSPECIFIED|UNKNOWN|TBD|NONE|N\/A|^$/i.test(id);
      return {
        id,
        problems: [
          problem(isUnknown ? "LICENSE_MISSING" : "LICENSE_RESTRICTED", "error", "licenseType", `${reason} (${raw})`),
        ],
        rights: {
          commercialUse: isUnknown ? "UNKNOWN" : "NO",
          redistribution: isUnknown ? "UNKNOWN" : "NO",
          modification: isUnknown ? "UNKNOWN" : "NO",
          attributionRequired: false,
          class: isUnknown ? "UNKNOWN" : "RESTRICTED",
        },
      };
    }
  }
  const known = OPEN_LICENSES[id];
  if (!known) {
    problems.push(
      problem("LICENSE_NOT_IN_ALLOWLIST", "error", "licenseType", `"${raw}" is not in the reviewed open-license allowlist`),
    );
    return {
      id,
      problems,
      rights: { commercialUse: "UNKNOWN", redistribution: "UNKNOWN", modification: "UNKNOWN", attributionRequired: false, class: "UNKNOWN" },
    };
  }
  return {
    id,
    problems,
    rights: {
      commercialUse: "YES",
      redistribution: "YES",
      modification: "YES",
      attributionRequired: known.attributionRequired,
      class: known.shareAlike ? "OPEN_SHARE_ALIKE" : known.attributionRequired ? "OPEN_ATTRIBUTION" : "OPEN_PERMISSIVE",
    },
  };
}

/** ISO-8601 date (date or date-time) in the past and after 2000-01-01. */
export function isValidAcquisitionDate(value: string, now = new Date()): boolean {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  const d = new Date(t);
  if (d.getTime() > now.getTime() + 24 * 3600 * 1000) return false; // allow timezone slack, not the future
  return d.getUTCFullYear() >= 2000;
}

function isPlaceholderUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return true;
    return PLACEHOLDER_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return true;
  }
}

/**
 * Validate a provenance record against the file that was actually obtained.
 * `actual` values come from the bytes on disk, never from the record itself.
 */
export function validateProvenance(
  record: ProvenanceRecord,
  actual: { fileSize: number; sha256: string },
  opts: { requirePromotionReady?: boolean } = {},
): ProvenanceCheck {
  const problems: Problem[] = [];
  const license = classifyLicense(record.licenseType ?? "");
  problems.push(...license.problems);
  const rights = license.rights;

  if (!record.assetIdentity || record.assetIdentity.trim().length < 3) {
    problems.push(problem("IDENTITY_REQUIRED", "error", "assetIdentity", "state what the asset claims to be"));
  }
  if (!record.sourceUrl || isPlaceholderUrl(record.sourceUrl)) {
    problems.push(problem("SOURCE_URL_UNVERIFIABLE", "error", "sourceUrl", record.sourceUrl || "(empty)"));
  }
  if (!record.sourceProvider || record.sourceProvider.trim().length < 2) {
    problems.push(problem("PROVIDER_REQUIRED", "error", "sourceProvider"));
  }
  if (record.licenseUrl && isPlaceholderUrl(record.licenseUrl)) {
    problems.push(problem("LICENSE_URL_UNVERIFIABLE", "error", "licenseUrl", record.licenseUrl));
  }
  if (rights.class === "OPEN_ATTRIBUTION" || rights.class === "OPEN_SHARE_ALIKE") {
    if (!record.licenseUrl) problems.push(problem("LICENSE_URL_REQUIRED", "error", "licenseUrl", "attribution licenses must cite the canonical license text"));
    if (!record.attributionText || record.attributionText.trim().length < 4) {
      problems.push(problem("ATTRIBUTION_TEXT_REQUIRED", "error", "attributionText"));
    } else if (record.creator && !record.attributionText.includes(record.creator)) {
      problems.push(problem("ATTRIBUTION_MISSING_CREATOR", "warning", "attributionText", "credit string does not name the creator"));
    }
  }
  if (record.creator === null || record.creator.trim().length === 0) {
    // Ingestion may proceed with an unknown creator (the download page may not
    // name one), but promotion is blocked — a credit we cannot render is a
    // license risk. Unknown stays UNKNOWN; it is never filled in.
    problems.push(problem("CREATOR_UNKNOWN", "warning", "creator"));
  }
  if (!isValidAcquisitionDate(record.downloadDate ?? "")) {
    problems.push(problem("ACQUISITION_DATE_INVALID", "error", "downloadDate", record.downloadDate || "(empty)"));
  }
  if (!record.originalFilename || /[/\\]/.test(record.originalFilename)) {
    problems.push(problem("ORIGINAL_FILENAME_INVALID", "error", "originalFilename", record.originalFilename || "(empty)"));
  }
  if (!Number.isInteger(record.fileSize) || record.fileSize <= 0) {
    problems.push(problem("FILE_SIZE_INVALID", "error", "fileSize", String(record.fileSize)));
  } else if (record.fileSize !== actual.fileSize) {
    problems.push(problem("FILE_SIZE_MISMATCH", "error", "fileSize", `record ${record.fileSize} ≠ observed ${actual.fileSize}`));
  }
  if (!/^[0-9a-f]{64}$/i.test(record.sha256 ?? "")) {
    problems.push(problem("CHECKSUM_INVALID", "error", "sha256", "64 hex characters required"));
  } else if (record.sha256.toLowerCase() !== actual.sha256.toLowerCase()) {
    problems.push(problem("CHECKSUM_MISMATCH", "error", "sha256", `record ${record.sha256.slice(0, 16)}… ≠ observed ${actual.sha256.slice(0, 16)}…`));
  }
  if (!record.intendedUsage || record.intendedUsage.trim().length < 3) {
    problems.push(problem("INTENDED_USAGE_REQUIRED", "error", "intendedUsage"));
  }
  if (record.modifications !== null && record.modifications !== undefined && record.modifications.length > 400) {
    problems.push(problem("MODIFICATIONS_TOO_LONG", "warning", "modifications"));
  }

  // Rights tri-state — the hard stop of §38.
  for (const [field, value] of [
    ["commercialUse", record.commercialUse],
    ["redistributionAllowed", record.redistributionAllowed],
    ["modificationAllowed", record.modificationAllowed],
  ] as const) {
    if (value === "UNKNOWN") problems.push(problem("RIGHT_UNKNOWN", "error", field, "unknown rights cannot enter the production pipeline"));
    else if (value === "NO") problems.push(problem("RIGHT_NOT_GRANTED", "error", field));
  }

  const canIngest = !problems.some((p) => p.severity === "error");
  // Promotion adds the auditability rules on top of "no errors".
  const promotionBlocks = problems.filter(
    (p) => p.severity === "error" || (opts.requirePromotionReady && p.code === "CREATOR_UNKNOWN"),
  );
  return { problems, rights, canIngest, canPromote: promotionBlocks.length === 0 };
}

/**
 * Rights gate used by the promotion pipeline: an asset may only be promoted
 * when the license classification is open AND all three rights are YES.
 */
export function rightsAllowProduction(rights: RightsSummary): { ok: boolean; reason?: string } {
  if (rights.class === "RESTRICTED" || rights.class === "UNKNOWN") return { ok: false, reason: `LICENSE_${rights.class}` };
  if (rights.commercialUse !== "YES") return { ok: false, reason: "COMMERCIAL_USE_NOT_GRANTED" };
  if (rights.redistribution !== "YES") return { ok: false, reason: "REDISTRIBUTION_NOT_GRANTED" };
  if (rights.modification !== "YES") return { ok: false, reason: "MODIFICATION_NOT_GRANTED" };
  return { ok: true };
}
