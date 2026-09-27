// P2-J (J3): GLB container parsing. Treats every downloaded file as untrusted
// input: nothing is executed, nothing is resolved over the network, and every
// declared length is cross-checked against the bytes actually present.
import { Problem, problem } from "./types";

const MAGIC_GLTF = 0x46546c67; // "glTF" little-endian
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export type RawChunk = { type: string; length: number; offset: number; data: Buffer };

export type ParsedGlb =
  | { ok: true; version: number; declaredLength: number; chunks: RawChunk[]; jsonText: string; json: Record<string, unknown>; bin: Buffer | null }
  | { ok: false; problems: Problem[]; partial?: { version: number; declaredLength: number } };

function chunkTypeName(t: number): string {
  if (t === CHUNK_JSON) return "JSON";
  if (t === CHUNK_BIN) return "BIN";
  // Render unknown types as their 4 bytes, printable only.
  const b = Buffer.alloc(4);
  b.writeUInt32LE(t, 0);
  const s = b.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
  return `UNKNOWN(${s})`;
}

/**
 * Parse a .glb container. Fails closed on anything suspicious instead of
 * guessing: a truncated tail, a declared length that does not match the file,
 * a missing JSON chunk, or JSON that is not an object.
 */
export function parseGlb(buf: Buffer): ParsedGlb {
  const problems: Problem[] = [];

  if (buf.length < 12) {
    return { ok: false, problems: [problem("FILE_TOO_SMALL", "error", "header", `${buf.length} bytes`)] };
  }

  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const declaredLength = buf.readUInt32LE(8);

  if (magic !== MAGIC_GLTF) {
    // Bare glTF (.gltf JSON) is not a GLB; report it precisely instead of "invalid".
    if (buf[0] === 0x7b) {
      return { ok: false, problems: [problem("NOT_A_GLB", "error", "header", "file is JSON (.gltf) — a self-contained .glb is required")] };
    }
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      return { ok: false, problems: [problem("NOT_A_GLB", "error", "header", "file is a ZIP archive — unpack and convert to .glb")] };
    }
    return { ok: false, problems: [problem("NOT_A_GLB", "error", "header", `magic 0x${magic.toString(16)}`)] };
  }
  if (version !== 2) {
    return {
      ok: false,
      problems: [problem("GLB_VERSION_UNSUPPORTED", "error", "header", `container version ${version} (only 2 is supported)`)],
      partial: { version, declaredLength },
    };
  }
  if (declaredLength !== buf.length) {
    return {
      ok: false,
      problems: [problem("LENGTH_MISMATCH", "error", "header", `header says ${declaredLength}, file is ${buf.length}`)],
      partial: { version, declaredLength },
    };
  }

  const chunks: RawChunk[] = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (dataStart + length > buf.length) {
      problems.push(
        problem("CHUNK_TRUNCATED", "error", `chunk@${offset}`, `declared ${length} bytes, only ${buf.length - dataStart} present`),
      );
      break;
    }
    chunks.push({ type: chunkTypeName(type), length, offset: dataStart, data: buf.subarray(dataStart, dataStart + length) });
    offset = dataStart + length; // stored chunk lengths are already 4-byte aligned
  }

  if (offset !== buf.length && problems.length === 0) {
    problems.push(problem("TRAILING_BYTES", "warning", `offset ${offset}`, `${buf.length - offset} unparsed trailing bytes`));
  }
  if (chunks.length === 0) {
    problems.push(problem("NO_CHUNKS", "error", "container", "no chunks found"));
    return { ok: false, problems };
  }
  const firstChunk = chunks[0];
  if (!firstChunk || firstChunk.type !== "JSON") {
    problems.push(problem("JSON_CHUNK_NOT_FIRST", "error", "chunks[0]", `first chunk is ${firstChunk ? firstChunk.type : "(none)"}`));
    return { ok: false, problems };
  }
  if (problems.some((p) => p.severity === "error")) return { ok: false, problems };

  const jsonText = firstChunk.data.toString("utf8").replace(/\u0000+$/, "").trim();
  if (jsonText.length === 0) {
    return { ok: false, problems: [problem("EMPTY_JSON_CHUNK", "error", "chunks[0]")] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return {
      ok: false,
      problems: [problem("MALFORMED_GLTF_JSON", "error", "chunks[0]", e instanceof Error ? e.message.slice(0, 160) : "parse error")],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, problems: [problem("MALFORMED_GLTF_JSON", "error", "chunks[0]", "top-level JSON is not an object")] };
  }
  const json = parsed as Record<string, unknown>;
  if (typeof json.asset !== "object" || json.asset === null) {
    problems.push(problem("MISSING_ASSET_BLOCK", "error", "asset", "glTF requires an `asset` object"));
  }

  const binChunk = chunks.find((c) => c.type === "BIN") ?? null;
  if (problems.some((p) => p.severity === "error")) return { ok: false, problems };

  return {
    ok: true,
    version,
    declaredLength,
    chunks,
    jsonText,
    json,
    bin: binChunk ? binChunk.data : null,
  };
}

/** True when the buffer starts with the GLB magic (cheap pre-check). */
export function hasGlbMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === MAGIC_GLTF;
}
