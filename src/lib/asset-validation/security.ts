// P2-J (J3 + §9): security scan of an untrusted glTF/GLB file.
//
// The pipeline never executes asset content and never resolves asset-provided
// URLs. This module exists to *prove* that: it enumerates every reference the
// document asks a consumer to fetch, flags anything outside the file, and
// rejects resource-bomb shapes before they reach a server or a browser.
import { LIMITS, Problem, problem } from "./types";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const MAX_URI_REPORTED = 200;

export type SecurityResult = {
  problems: Problem[];
  /** Every non-embedded reference the document declares (must be empty to ship). */
  externalReferences: string[];
  /** Bytes carried as inline data URIs. */
  dataUriBytes: number;
  /** URLs found in metadata (`asset.extras`, `asset.copyright`) — informational. */
  metadataUrls: string[];
};

function isDataUri(uri: string): boolean {
  return /^data:/i.test(uri);
}

/** Suspicious shapes inside a URI or file name. */
function classifyUri(uri: string): string | null {
  const lower = uri.toLowerCase();
  if (/[\u0000-\u001f\u007f]/.test(uri)) return "control character in URI";
  if (uri.includes("\\")) return "backslash path separator";
  if (/^\/\//.test(uri)) return "protocol-relative URI";
  if (lower.startsWith("file:")) return "file: scheme";
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !isDataUri(uri)) return "absolute URI with scheme";
  if (/(^|\/)\.\.(\/|$)/.test(uri)) return "path traversal segment";
  if (lower.includes("%2e%2e") || lower.includes("%2f") || lower.includes("%00")) return "percent-encoded traversal";
  if (/^[a-z]:/i.test(uri)) return "absolute filesystem path";
  if (uri.startsWith("/")) return "absolute path";
  return null;
}

function countDataUriBytes(uri: string): number {
  const m = /^data:([^;,]*)(;base64)?,/i.exec(uri);
  if (!m) return 0;
  const payload = uri.slice(m[0].length);
  return m[2] ? Math.floor((payload.length * 3) / 4) : payload.length;
}

/**
 * Scan the document for external references, suspicious strings, embedded
 * payloads and resource-bomb shapes. Runs on the raw bytes plus the parsed JSON.
 */
export function scanSecurity(json: Json, bin: Buffer | null, raw: Buffer, chunks: { type: string }[]): SecurityResult {
  const problems: Problem[] = [];
  const externalReferences: string[] = [];
  const metadataUrls: string[] = [];
  let dataUriBytes = 0;

  // ── 1. every declared URI ─────────────────────────────────────────────────
  const uriSites: { where: string; uri: string }[] = [];
  arr(json.buffers).forEach((b, i) => {
    if (isObj(b) && typeof b.uri === "string") uriSites.push({ where: `buffers[${i}].uri`, uri: b.uri });
  });
  arr(json.images).forEach((img, i) => {
    if (isObj(img) && typeof img.uri === "string") uriSites.push({ where: `images[${i}].uri`, uri: img.uri });
  });
  // Shader/extras-style references inside extensions are checked generically below.

  for (const { where, uri } of uriSites) {
    if (isDataUri(uri)) {
      const bytes = countDataUriBytes(uri);
      dataUriBytes += bytes;
      if (bytes > LIMITS.failDataUriBytes) {
        problems.push(problem("LIMIT_INLINE_DATA", "error", where, `${bytes} inline bytes > ${LIMITS.failDataUriBytes}`));
      }
      continue;
    }
    if (uri.length > MAX_URI_REPORTED * 8) {
      problems.push(problem("SUSPICIOUS_URI", "error", where, `abnormally long URI (${uri.length} chars)`));
    }
    const why = classifyUri(uri);
    if (why) problems.push(problem("SUSPICIOUS_URI", "error", where, `${why}: ${uri.slice(0, MAX_URI_REPORTED)}`));
    externalReferences.push(uri.slice(0, MAX_URI_REPORTED));
  }
  if (externalReferences.length > 0) {
    problems.push(
      problem(
        "EXTERNAL_REFERENCE",
        "error",
        "document",
        `${externalReferences.length} external reference(s) — a self-contained .glb is required`,
      ),
    );
  }

  // ── 2. metadata URLs (informational, e.g. Sketchfab `asset.extras`) ────────
  const asset = isObj(json.asset) ? json.asset : {};
  const collectUrls = (v: unknown, depth = 0): void => {
    if (depth > 6) return;
    if (typeof v === "string" && /^https?:\/\//i.test(v) && metadataUrls.length < 20) metadataUrls.push(v.slice(0, MAX_URI_REPORTED));
    else if (Array.isArray(v)) v.forEach((x) => collectUrls(x, depth + 1));
    else if (isObj(v)) Object.values(v).forEach((x) => collectUrls(x, depth + 1));
  };
  collectUrls(asset.extras);
  collectUrls(asset.copyright);

  // ── 3. embedded payload / script markers ──────────────────────────────────
  const jsonText = JSON.stringify(json);
  const scriptMarkers = ["<script", "javascript:", "onerror=", "<html", "<iframe", "data:text/html", "eval("];
  for (const marker of scriptMarkers) {
    if (jsonText.toLowerCase().includes(marker)) {
      problems.push(problem("SUSPICIOUS_CONTENT_MARKER", "error", "chunks[JSON]", `contains "${marker}"`));
    }
  }
  const prototypeKeys = ["__proto__", "constructor.prototype"];
  for (const key of prototypeKeys) {
    if (jsonText.includes(`"${key}"`)) problems.push(problem("PROTOTYPE_KEY", "warning", "chunks[JSON]", key));
  }

  if (bin) {
    const head = bin.subarray(0, 4);
    const magic = head.toString("latin1");
    if (magic.startsWith("MZ")) problems.push(problem("EMBEDDED_EXECUTABLE", "error", "chunks[BIN]", "MZ/PE header inside binary chunk"));
    if (head[0] === 0x7f && magic.slice(1, 4) === "ELF") problems.push(problem("EMBEDDED_EXECUTABLE", "error", "chunks[BIN]", "ELF header inside binary chunk"));
    if (head[0] === 0x50 && head[1] === 0x4b) problems.push(problem("EMBEDDED_ARCHIVE", "error", "chunks[BIN]", "ZIP header inside binary chunk (archive/decompression-bomb shape)"));
  }
  for (const c of chunks) {
    if (c.type !== "JSON" && c.type !== "BIN") problems.push(problem("UNKNOWN_CHUNK", "warning", "container", c.type));
  }

  // ── 4. resource-bomb shapes ───────────────────────────────────────────────
  for (const [i, a] of arr(json.accessors).entries()) {
    if (!isObj(a)) continue;
    const count = typeof a.count === "number" ? a.count : 0;
    if (count > 50_000_000) problems.push(problem("LIMIT_ACCESSOR_COUNT", "error", `accessors[${i}].count`, String(count)));
  }
  for (const [i, img] of arr(json.images).entries()) {
    if (!isObj(img)) continue;
    const uri = typeof img.uri === "string" ? img.uri : null;
    if (uri && isDataUri(uri)) {
      const bytes = countDataUriBytes(uri);
      if (bytes > LIMITS.failDataUriBytes) problems.push(problem("LIMIT_IMAGE_BYTES", "error", `images[${i}]`, String(bytes)));
    }
  }
  // Declared buffer view byte lengths must not claim more memory than the file.
  for (const [i, bv] of arr(json.bufferViews).entries()) {
    if (!isObj(bv)) continue;
    const len = typeof bv.byteLength === "number" ? bv.byteLength : 0;
    if (len > raw.length) {
      problems.push(problem("BUFFERVIEW_EXCEEDS_FILE", "error", `bufferViews[${i}].byteLength`, `${len} > file ${raw.length}`));
    }
  }

  return { problems, externalReferences, dataUriBytes, metadataUrls };
}
