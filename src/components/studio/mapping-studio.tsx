"use client";

import { Suspense, useMemo, useRef, useState, useTransition } from "react";
import { Canvas, useLoader, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import {
  assignMeshAction, unassignMeshAction, updateMappingMetaAction, refreshMappingHealthAction,
  validateVersionAction, stageVersionAction, recordVerificationAction,
  promoteVersionAction, rollbackVersionAction, retireVersionAction, rejectVersionAction,
} from "@/app/studio-actions";
import type { PromotionGate } from "@/lib/asset-registry";

type Problem = { code: string; severity: string; where?: string; detail?: string };

type StudioMetrics = {
  fileBytes: number; triangles: number; vertices: number; nodes: number; meshes: number; materials: number;
  textures: number; images: number; largestTextureDimension: number; estimatedGpuBytes: number;
};

export type StudioVersionRow = {
  id: string; version: number; state: string; createdAt: string;
  fileSize: number | null; mimeType: string | null; checksum: string | null;
  filePath: string | null; rawFilePath: string | null; rawFileSize: number | null; rawChecksum: string | null;
  licenseType: string | null; licenseUrl: string | null; sourceUrl: string | null; sourceProvider: string | null;
  creator: string | null; attributionText: string | null;
  commercialUse: boolean; redistributionAllowed: boolean | null; modificationAllowed: boolean | null;
  acquiredAt: string | null; intendedUsage: string | null; modifications: string | null;
  provenanceComplete: boolean; mappingCount: number;
  validatedAt: string | null; optimizedAt: string | null; stagedAt: string | null;
  verifiedAt: string | null; promotedAt: string | null; verifiedBy: string | null;
  promotionNote: string | null; rejectionReason: string | null;
  validation: {
    verdict: string; structure: string; security: string; selfContained: string; provenance: string | null;
    sha256: string; byteLength: number; inventoryHash: string | null; meshNodeCount: number; unnamedMeshNodes: number;
    problems: Problem[];
    metrics: StudioMetrics | null;
  } | null;
  rawValidation: { verdict: string; sha256: string; byteLength: number; metrics: StudioMetrics | null } | null;
  optimization: {
    deltas?: Record<string, { raw: number; optimized: number; ratio: number }>;
    warnings?: string[];
    optimizer?: { tool?: string; settings?: Record<string, unknown> };
    measuredAt?: string;
    optimizedObjectKey?: string;
  } | null;
  inventory: {
    nodeName: string; path: string; meshName: string; nameSource: string;
    triangles: number; vertices: number; primitives: number; visible: boolean; fingerprint: string;
  }[] | null;
  mappingHealth: { meshName: string; kind: string; status: string; detail?: string }[];
  renderVerification: {
    source: string; url: string; checkedAt: string; by: string; viewports: string[];
    observations: string[]; consoleErrors?: number; networkFailures?: number; webglErrors?: number;
  } | null;
  mappings: {
    meshName: string; kind: string; label: string | null;
    meshFingerprint: string | null; mappingHealth: string | null;
    zoneId: string | null; assemblyId: string | null; partId: string | null; hotspot: number[] | null;
  }[];
};

type Props = {
  asset: { assetId: string; source: string; kind: string; vehicleId: string | null; versions: StudioVersionRow[] };
  zones: { id: string; label: string }[];
  assemblies: { id: string; label: string }[];
  parts: { id: string; label: string }[];
  events: { id: string; event: string; fromState: string | null; toState: string | null; actor: string; note: string | null; createdAt: string }[];
};

const FA_STATE: Record<string, string> = {
  PLACEHOLDER: "نمونهٔ جایگزین", RAW: "خام", VALIDATED: "اعتبارسنجی‌شده", OPTIMIZED: "بهینه‌شده",
  STAGED: "آمادهٔ بازبینی", VERIFIED: "تأییدشدهٔ رندر", PRODUCTION: "تولیدی", RETIRED: "بازنشسته", REJECTED: "رد‌شده",
};
const STATE_STYLE: Record<string, string> = {
  PLACEHOLDER: "bg-amber-100 text-amber-800",
  RAW: "bg-black/6 text-black/70",
  VALIDATED: "bg-sky-100 text-sky-800",
  OPTIMIZED: "bg-indigo-100 text-indigo-800",
  STAGED: "bg-violet-100 text-violet-800",
  VERIFIED: "bg-teal-100 text-teal-800",
  PRODUCTION: "bg-green-100 text-green-800",
  RETIRED: "bg-black/6 text-black/50",
  REJECTED: "bg-red-100 text-red-800",
};
const FA_HEALTH: Record<string, string> = {
  MAPPING_VALID: "معتبر", MAPPING_NEEDS_REVIEW: "نیازمند بازبینی", MAPPING_INVALID: "نامعتبر",
};
const HEALTH_STYLE: Record<string, string> = {
  MAPPING_VALID: "bg-green-100 text-green-800",
  MAPPING_NEEDS_REVIEW: "bg-amber-100 text-amber-800",
  MAPPING_INVALID: "bg-red-100 text-red-800",
};
const FA_EVENT: Record<string, string> = {
  created: "ایجاد", validated: "اعتبارسنجی", rejected: "رد", optimized: "بهینه‌سازی", staged: "آماده‌سازی",
  verified: "تأیید رندر", promoted: "انتشار", retired: "بازنشستگی", rolled_back: "بازگشت", mapping_assigned: "نگاشت",
  mapping_removed: "حذف نگاشت", health_checked: "بررسی سلامت",
};
const FA_PROBLEM: Record<string, string> = {
  EXTERNAL_REFERENCE: "ارجاع بیرونی", SUSPICIOUS_URI: "نشانی مشکوک", NOT_A_GLB: "فایل GLB نیست",
  LENGTH_MISMATCH: "طول فایل ناهمخوان", DANGLING_REFERENCE: "ارجاع نامعتبر", NODE_GRAPH_CYCLE: "حلقه در سلسله‌مراتب",
  NON_FINITE_NUMBER: "عدد نامعتبر", LICENSE_MISSING: "مجوز ثبت نشده", LICENSE_RESTRICTED: "مجوز محدود",
  LICENSE_NOT_IN_ALLOWLIST: "مجوز بازبینی‌نشده", RIGHT_UNKNOWN: "وضعیت حق نامعلوم", RIGHT_NOT_GRANTED: "حق واگذار نشده",
  CHECKSUM_MISMATCH: "چک‌سام ناهمخوان", FILE_SIZE_MISMATCH: "اندازهٔ فایل ناهمخوان", SOURCE_URL_UNVERIFIABLE: "منبع نامعتبر",
  ACQUISITION_DATE_INVALID: "تاریخ تهیه نامعتبر", ATTRIBUTION_TEXT_REQUIRED: "متن اعتباردهی لازم است",
  CREATOR_UNKNOWN: "پدیدآورنده نامعلوم", INTENDED_USAGE_REQUIRED: "کاربرد اعلام‌شده لازم است",
  POSITION_MISSING_BOUNDS: "بدون کادر محدودکننده", PRIMITIVE_WITHOUT_INDICES: "بدون نمایه",
  DEGENERATE_MESHES: "مش تخریب‌شده", DELIVERY_TRIANGLES_HIGH: "تعداد مثلث بالا", DELIVERY_FILE_LARGE: "حجم فایل بالا",
};
function faProblem(code: string): string {
  return FA_PROBLEM[code] ?? code;
}
function faBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function configureLoader(loader: unknown): void {
  const gltfLoader = loader as GLTFLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  gltfLoader.setDRACOLoader(draco);
  gltfLoader.setMeshoptDecoder(MeshoptDecoder);
}

/** Demo geometry mirroring the synthetic placeholder viewer (stable mesh names). */
function DemoMeshes({ onSelect, selected }: { onSelect: (name: string | null) => void; selected: string | null }) {
  const boxes: { name: string; pos: [number, number, number]; size: [number, number, number]; color: string }[] = [
    { name: "zone_body", pos: [0, 0.95, 0.1], size: [1.7, 0.55, 3.4], color: "#9aa3b2" },
    { name: "zone_engine", pos: [0, 0.72, 1.15], size: [1.1, 0.5, 0.7], color: "#6b7280" },
    { name: "part_oil_filter_main", pos: [0.62, 0.45, 1.3], size: [0.16, 0.32, 0.16], color: "#f59e0b" },
    { name: "part_radiator_main", pos: [0, 0.62, 1.62], size: [1.15, 0.6, 0.1], color: "#4b5563" },
    { name: "zone_wheels", pos: [0.85, 0.34, 1.15], size: [0.24, 0.68, 0.68], color: "#1c1d22" },
    { name: "part_brake_pad_front_main", pos: [0.62, 0.34, 1.15], size: [0.1, 0.3, 0.3], color: "#ef4444" },
    { name: "part_battery_main", pos: [-0.45, 0.95, 1.2], size: [0.35, 0.25, 0.25], color: "#111827" },
    { name: "zone_interior", pos: [0, 1.35, -0.4], size: [1.3, 0.15, 0.5], color: "#334155" },
    { name: "part_floor_mat_main", pos: [0, 1.12, -0.35], size: [1.2, 0.04, 1.2], color: "#0f172a" },
  ];
  return (
    <group position={[0, -0.15, 0]}>
      {boxes.map((b) => (
        <mesh key={b.name} name={b.name} position={b.pos}
          onClick={(e) => { e.stopPropagation(); onSelect(b.name); }}>
          <boxGeometry args={b.size} />
          <meshStandardMaterial color={selected === b.name ? "#1668e3" : b.color} />
        </mesh>
      ))}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]}>
        <circleGeometry args={[7, 48]} />
        <meshStandardMaterial color="#eceef2" />
      </mesh>
    </group>
  );
}

/**
 * Real-asset inspection (J12): the stored artifact is streamed through the
 * admin-only route, so the studio can select real nodes instead of guessing.
 * Node names come from the file — nothing is renamed or invented here.
 */
function RealAssetMeshes({ url, onSelect, selected }: { url: string; onSelect: (name: string | null) => void; selected: string | null }) {
  const gltf = useLoader(GLTFLoader, url, configureLoader);
  const scene = useMemo(() => {
    const clone = gltf.scene.clone(true);
    clone.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material)
        ? (mesh.material as THREE.Material[]).map((mm) => mm.clone())
        : (mesh.material as THREE.Material).clone();
      const selectedHere = mesh.name === selected;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const std = m as THREE.MeshStandardMaterial;
        if (selectedHere && std.color) std.color.set("#1668e3");
        std.opacity = selected === null || selectedHere ? 1 : 0.35;
        std.transparent = selected !== null && !selectedHere;
        std.depthWrite = !(selected !== null && !selectedHere);
      }
    });
    return clone;
  }, [gltf, selected]);

  return (
    <primitive object={scene}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        const name = e.object.name && e.object.name.length > 0 ? e.object.name : null;
        onSelect(name);
      }} />
  );
}

export function MappingStudio({ asset, zones, assemblies, parts, events }: Props) {
  const [selectedVersionId, setSelectedVersionId] = useState(asset.versions[0]?.id ?? "");
  const [selectedMesh, setSelectedMesh] = useState<string | null>(null);
  const [kind, setKind] = useState<"zone" | "assembly" | "part">("zone");
  const [targetId, setTargetId] = useState(zones[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [verifyUrl, setVerifyUrl] = useState("https://poom-jet.vercel.app");
  const [message, setMessage] = useState<string | null>(null);
  const [gates, setGates] = useState<PromotionGate[] | null>(null);
  const [pending, start] = useTransition();
  // drei's OrbitControls ref type is class-internal; the shape we read is
  // documented (object = camera, target = Vector3) and guarded at use site.
  const orbitRef = useRef<any>(null);
  void THREE;

  const version = asset.versions.find((v) => v.id === selectedVersionId) ?? asset.versions[0] ?? null;
  const options = kind === "zone" ? zones : kind === "assembly" ? assemblies : parts;
  const inventoryEntry = version?.inventory?.find((e) => e.nodeName === selectedMesh) ?? null;
  const noMappingYet = version?.inventory === null;

  const run = (fn: () => Promise<{ ok: boolean; error?: string; problems?: string[] }>, done: string) => {
    start(async () => {
      setGates(null);
      const res = await fn();
      if (res.ok) {
        setMessage(done);
        setTimeout(() => location.reload(), 900);
        return;
      }
      setMessage(`خطا: ${res.error ?? "UNKNOWN"}${res.problems && res.problems.length > 0 ? ` — ${res.problems.slice(0, 5).join("، ")}` : ""}`);
      if (res.problems && res.problems.length > 0) {
        setGates(res.problems.map((id) => ({ id, label: id, pass: false })));
      }
    });
  };

  const captureCamera = () => {
    const cam = orbitRef.current?.object as THREE.PerspectiveCamera | undefined;
    const target = orbitRef.current?.target;
    if (!cam || !target || !selectedMesh) return;
    const pos = [+cam.position.x.toFixed(3), +cam.position.y.toFixed(3), +cam.position.z.toFixed(3)];
    const tgt = [+target.x.toFixed(3), +target.y.toFixed(3), +target.z.toFixed(3)];
    start(async () => {
      await updateMappingMetaAction({ versionId: selectedVersionId, meshName: selectedMesh, cameraPosition: pos, cameraTarget: tgt });
      setMessage(`دوربین برای ${selectedMesh} ثبت شد`);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">استودیو نگاشت سه‌بعدی</h1>
          <span className="font-mono text-xs text-black/50" dir="ltr">{asset.assetId}</span>
          <span className={`badge ms-2 ${asset.kind === "REAL" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
            {asset.kind === "REAL" ? "دارایی واقعی" : "نمونهٔ جایگزین (سینتتیک)"}
          </span>
        </div>
        <a href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</a>
      </div>

      {/* versions */}
      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">نسخه‌ها</h2>
        <div className="flex flex-wrap gap-2">
          {asset.versions.map((v) => (
            <button key={v.id} onClick={() => { setSelectedVersionId(v.id); setSelectedMesh(null); }}
              className={`badge ${v.id === selectedVersionId ? "bg-[var(--color-accent)] text-white" : STATE_STYLE[v.state] ?? "bg-black/6"}`}>
              v{v.version} · {FA_STATE[v.state] ?? v.state} · {v.mappingCount} نگاشت
            </button>
          ))}
        </div>
        {version && (
          <div className="grid gap-2 text-[11px] leading-5 text-black/60 md:grid-cols-2">
            <div>
              وضعیت: <span className={`badge ${STATE_STYLE[version.state] ?? "bg-black/6"}`}>{FA_STATE[version.state] ?? version.state}</span>
              {" · "}فایل فعال: <span dir="ltr">{version.filePath ?? "بدون فایل (هندسهٔ درون‌مخزن)"}</span>
            </div>
            <div>حجم فایل فعال: {version.fileSize ? faBytes(version.fileSize) : "—"}</div>
            {version.rawFilePath && (
              <div className="md:col-span-2" dir="ltr">
                RAW: {version.rawFilePath} · {version.rawFileSize ? `${version.rawFileSize} B` : "—"} · sha256 {(version.rawChecksum ?? "").slice(0, 16)}…
              </div>
            )}
            <div className="md:col-span-2" dir="ltr">sha256 {(version.checksum ?? "").slice(0, 24) || "—"}…</div>
            <div className="md:col-span-2">
              مجوز: {version.licenseType ?? "—"} · استفاده تجاری: {version.commercialUse ? "بله" : "خیر"} ·
              بازتوزیع: {version.redistributionAllowed === null ? "نامعلوم" : version.redistributionAllowed ? "بله" : "خیر"} ·
              تغییر: {version.modificationAllowed === null ? "نامعلوم" : version.modificationAllowed ? "بله" : "خیر"}
              {version.licenseUrl && <> · <span dir="ltr">{version.licenseUrl}</span></>}
            </div>
            <div className="md:col-span-2">
              منبع: <span dir="ltr">{version.sourceUrl ?? "—"}</span> · ارائه‌دهنده: {version.sourceProvider ?? "—"} · پدیدآورنده: {version.creator ?? "نامعلوم"}
            </div>
            {version.attributionText && <div className="md:col-span-2">اعتباردهی: {version.attributionText}</div>}
            <div className="md:col-span-2">
              <span className={`badge ${version.provenanceComplete ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                {version.provenanceComplete ? "provenance کامل" : "provenance ناقص — انتشار ممکن نیست"}
              </span>
              {" · "}اعتبارسنجی: {version.validatedAt ?? "—"} · بهینه‌سازی: {version.optimizedAt ?? "—"} · آماده‌سازی: {version.stagedAt ?? "—"} ·
              تأیید رندر: {version.verifiedAt ?? "—"} · انتشار: {version.promotedAt ?? "—"}
            </div>
            {version.rejectionReason && <div className="md:col-span-2 text-red-700">دلیل رد: <span dir="ltr">{version.rejectionReason}</span></div>}
          </div>
        )}
      </section>

      {/* validation + optimization evidence */}
      {version?.validation && (
        <section className="card space-y-2 p-4 text-xs" data-testid="validation-evidence">
          <h2 className="font-semibold">اعتبارسنجی فنی</h2>
          <div className="flex flex-wrap gap-1">
            {[
              ["ساختار", version.validation.structure],
              ["امنیت", version.validation.security],
              ["خودبسندگی", version.validation.selfContained],
              ["provenance", version.validation.provenance ?? "NOT_EVALUATED"],
            ].map(([k, v]) => (
              <span key={k} className={`badge ${v === "PASS" ? "bg-green-100 text-green-800" : v === "FAIL" ? "bg-red-100 text-red-800" : "bg-black/6"}`}>
                {k}: {v}
              </span>
            ))}
            <span className="badge bg-black/6" dir="ltr">inventory {version.validation.inventoryHash?.slice(0, 12) ?? "—"}</span>
            <span className="badge bg-black/6">نودها: {version.validation.meshNodeCount} (بی‌نام: {version.validation.unnamedMeshNodes})</span>
          </div>
          {version.validation.metrics && (
            <div className="text-black/60" dir="ltr">
              bytes={version.validation.metrics.fileBytes} tris={version.validation.metrics.triangles} verts={version.validation.metrics.vertices} ·
              nodes={version.validation.metrics.nodes} meshes={version.validation.metrics.meshes} materials={version.validation.metrics.materials} ·
              textures={version.validation.metrics.textures} maxTex={version.validation.metrics.largestTextureDimension}px ·
              gpu≈{faBytes(version.validation.metrics.estimatedGpuBytes)}
            </div>
          )}
          {version.validation.problems.length > 0 && (
            <ul className="space-y-0.5 text-[11px]">
              {version.validation.problems.slice(0, 10).map((p, i) => (
                <li key={`${p.code}-${i}`} className={p.severity === "error" ? "text-red-700" : "text-amber-700"}>
                  • {faProblem(p.code)} ({p.severity}) {p.where && <span dir="ltr">— {p.where}</span>}
                </li>
              ))}
            </ul>
          )}
          {version.optimization?.deltas && (
            <div className="rounded-lg bg-black/4 p-2" dir="ltr">
              {Object.entries(version.optimization.deltas).map(([k, d]) => (
                <div key={k}>{k}: {d.raw} → {d.optimized} ({Number.isFinite(d.ratio) ? `${((d.ratio - 1) * 100).toFixed(1)}%` : "n/a"})</div>
              ))}
              {version.optimization.optimizer?.tool && <div>tool: {version.optimization.optimizer.tool}</div>}
            </div>
          )}
          {version.renderVerification && (
            <div className="text-black/60">
              تأیید رندر: {version.renderVerification.source} · <span dir="ltr">{version.renderVerification.url}</span> ·{" "}
              نماها: {version.renderVerification.viewports.join("، ")} · خطای کنسول: {version.renderVerification.consoleErrors ?? "—"} ·
              خرابی شبکه: {version.renderVerification.networkFailures ?? "—"}
            </div>
          )}
        </section>
      )}

      {/* pipeline actions */}
      {version && (
        <section className="card space-y-2 p-4" data-testid="pipeline-actions">
          <h2 className="font-semibold">خط تولید دارایی</h2>
          <div className="flex flex-wrap gap-1">
            <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={pending || version.state !== "RAW"}
              onClick={() => run(() => validateVersionAction(version.id), "اعتبارسنجی انجام شد")}>
              اعتبارسنجی (RAW → VALIDATED)
            </button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={pending || version.state !== "OPTIMIZED"}
              onClick={() => run(() => stageVersionAction(version.id), "نسخه آمادهٔ بازبینی شد")}>
              آماده‌سازی (→ STAGED)
            </button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={pending || version.state !== "STAGED"}
              onClick={() => run(
                () => recordVerificationAction(version.id, {
                  url: verifyUrl,
                  viewports: ["desktop 1280×800", "mobile 390×844"],
                  observations: note.trim().length > 0 ? [note.trim()] : [],
                }),
                "تأیید رندر ثبت شد",
              )}>
              ثبت تأیید رندر (→ VERIFIED)
            </button>
            <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={pending || version.state !== "VERIFIED"}
              onClick={() => run(() => promoteVersionAction(version.id, note || "promotion from studio"), "نسخه منتشر شد")}>
              انتشار (→ PRODUCTION)
            </button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={pending || version.state !== "RETIRED"}
              onClick={() => run(() => rollbackVersionAction(version.id, note || "rollback from studio"), "بازگشت انجام شد")}>
              Rollback (RETIRED → PRODUCTION)
            </button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs !text-red-600" disabled={pending || version.state === "REJECTED" || version.state === "PRODUCTION"}
              onClick={() => run(() => retireVersionAction(version.id, note || "manual retire"), "نسخه بازنشسته شد")}>
              بازنشستگی
            </button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs !text-red-600" disabled={pending || version.state === "REJECTED" || version.state === "PRODUCTION"}
              onClick={() => run(() => rejectVersionAction(version.id, note || "manual reject"), "نسخه رد شد")}>
              رد نسخه
            </button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={pending}
              onClick={() => run(() => refreshMappingHealthAction(version.id), "سلامت نگاشت‌ها بررسی شد")}>
              بررسی سلامت نگاشت‌ها
            </button>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <input className="input !py-1 !text-xs" dir="ltr" value={verifyUrl} onChange={(e) => setVerifyUrl(e.target.value)}
              placeholder="نشانی تأیید رندر (Preview)" />
            <input className="input !py-1 !text-xs" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="یادداشت بازبینی / دلیل" />
          </div>
          <p className="text-[10px] leading-4 text-black/45">
            بهینه‌سازی از خط فرمان اجرا می‌شود (ابزار توسعه‌ای، نه وابستگی زمان اجرا). انتشار فقط با عبور از همهٔ دروازه‌ها ممکن است؛
            دارایی سینتتیک هرگز منتشر نمی‌شود.
          </p>
          {gates && gates.length > 0 && (
            <div className="rounded-lg bg-red-50 p-2 text-[11px] text-red-800">
              دروازه‌های ناموفق: {gates.map((g) => g.id).join("، ")}
            </div>
          )}
          {message && <div className="rounded-lg bg-blue-50 p-2 text-xs text-blue-800" data-testid="studio-message">{message}</div>}
        </section>
      )}

      {/* inspector */}
      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <section className="card overflow-hidden">
          <div className="h-[420px] w-full" role="img" aria-label="نمای سه‌بعدی استودیو نگاشت">
            <Canvas dpr={[1, 2]} camera={{ position: [6.5, 3.2, 7.5], fov: 45 }}>
              <color attach="background" args={["#f6f7f9"]} />
              <ambientLight intensity={0.9} />
              <directionalLight position={[5, 8, 4]} intensity={1.2} />
              <directionalLight position={[-6, 4, -4]} intensity={0.4} />
              {version?.filePath ? (
                <Suspense fallback={null}>
                  <RealAssetMeshes
                    url={`/api/admin/assets/${asset.assetId}/file?versionId=${version.id}`}
                    onSelect={setSelectedMesh}
                    selected={selectedMesh}
                  />
                </Suspense>
              ) : (
                <DemoMeshes onSelect={setSelectedMesh} selected={selectedMesh} />
              )}
              <OrbitControls makeDefault ref={orbitRef} enablePan={false} />
            </Canvas>
          </div>
          <div className="border-t border-black/8 p-2 text-center text-[11px] text-black/50">
            {version?.filePath
              ? "روی مش واقعی کلیک کنید · نام نود از خود فایل خوانده می‌شود"
              : "هندسهٔ درون‌مخزن (نمونهٔ جایگزین) — نام مش‌ها همان قرارداد نمایشی است"}
          </div>
        </section>

        <aside className="card space-y-3 p-4" data-testid="inspector">
          <h2 className="font-semibold">بازرس مش</h2>
          <div className="rounded-lg bg-black/4 p-2 font-mono text-xs" dir="ltr">
            {selectedMesh ?? "— mesh انتخاب نشده —"}
          </div>
          {inventoryEntry && (
            <div className="rounded-lg bg-black/4 p-2 text-[11px]" dir="ltr">
              path={inventoryEntry.path} · tris={inventoryEntry.triangles} · verts={inventoryEntry.vertices} ·
              primitives={inventoryEntry.primitives} · name={inventoryEntry.nameSource} · fp={inventoryEntry.fingerprint.slice(0, 12)}
            </div>
          )}
          {selectedMesh && inventoryEntry === null && (
            <div className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">
              این نود در فهرست اندازه‌گیری‌شدهٔ نسخه نیست — نگاشت روی آن مجاز نیست (NODE_NOT_IN_INVENTORY).
            </div>
          )}

          {selectedMesh && (
            <>
              <div className="grid grid-cols-3 gap-1">
                {(["zone", "assembly", "part"] as const).map((k) => (
                  <button key={k} onClick={() => { setKind(k); setTargetId((k === "zone" ? zones : k === "assembly" ? assemblies : parts)[0]?.id ?? ""); }}
                    className={`badge ${kind === k ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>
                    {k === "zone" ? "ناحیه" : k === "assembly" ? "اسمبلی" : "قطعه"}
                  </button>
                ))}
              </div>
              <select className="input !py-1 !text-xs" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <input className="input !py-1 !text-xs" placeholder="برچسب فارسی هات‌اسپات" value={label} onChange={(e) => setLabel(e.target.value)} />

              <div className="flex flex-wrap gap-1">
                <button className="btn-primary !px-2 !py-1 !text-xs" disabled={pending}
                  onClick={() => run(
                    () => assignMeshAction({ versionId: selectedVersionId, meshName: selectedMesh, kind, targetId, label: label || undefined }),
                    `${selectedMesh} → ${kind} ذخیره شد`,
                  )}>
                  ذخیره نگاشت
                </button>
                <button className="btn-ghost !px-2 !py-1 !text-xs" disabled={pending} onClick={captureCamera}>
                  ثبت دوربین فعلی
                </button>
                <button className="btn-ghost !px-2 !py-1 !text-xs !text-red-600" disabled={pending}
                  onClick={() => run(() => unassignMeshAction(selectedVersionId, selectedMesh), `${selectedMesh} حذف شد`)}>
                  حذف نگاشت
                </button>
              </div>
            </>
          )}

          {noMappingYet && (
            <p className="text-[10px] leading-4 text-black/45">
              این نسخه هنوز اعتبارسنجی نشده است، پس فهرست نودها موجود نیست و نگاشت‌ها «نیازمند بازبینی» می‌مانند.
            </p>
          )}

          {version && version.inventory && version.inventory.length > 0 && (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-black/60">فهرست نودهای فایل ({version.inventory.length})</summary>
              <ul className="mt-1 max-h-56 space-y-0.5 overflow-auto" dir="ltr">
                {version.inventory.map((e) => (
                  <li key={e.path + e.fingerprint}>
                    <button className="w-full text-start hover:bg-black/5" onClick={() => setSelectedMesh(e.nodeName)}>
                      • {e.nodeName || "(unnamed)"} — tris={e.triangles} verts={e.vertices} {e.visible ? "" : "[hidden]"}
                      {e.nameSource !== "AUTHORED" ? " [not mappable]" : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {version && version.mappingHealth.length > 0 && (
            <div className="text-[11px]">
              <div className="mb-1 text-black/60">سلامت نگاشت‌ها</div>
              <ul className="space-y-0.5">
                {version.mappingHealth.map((h) => (
                  <li key={`${h.kind}-${h.meshName}`} className="flex items-center justify-between gap-2">
                    <span className="font-mono" dir="ltr">{h.meshName}</span>
                    <span className={`badge ${HEALTH_STYLE[h.status] ?? "bg-black/6"}`} title={h.detail}>
                      {FA_HEALTH[h.status] ?? h.status}{h.detail && h.detail !== "OK" ? ` (${h.detail})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[10px] leading-4 text-black/40">
            نگاشت‌ها روی نسخهٔ انتخابی ذخیره می‌شوند و اثر انگشت نود را با خود می‌برند؛ اگر نسخهٔ بعدی نود را حذف/تغییر دهد،
            سلامت نگاشت به «نیازمند بازبینی» یا «نامعتبر» تغییر می‌کند. کاتالوگ و فروش بدون تغییر می‌مانند.
          </p>
        </aside>
      </div>

      {/* audit feed */}
      <section className="card space-y-2 p-4 text-xs" data-testid="asset-events">
        <h2 className="font-semibold">رویدادهای دارایی</h2>
        <ul className="space-y-0.5 text-[11px] text-black/60">
          {events.map((e) => (
            <li key={e.id}>
              • {FA_EVENT[e.event] ?? e.event}
              {e.fromState || e.toState ? <span dir="ltr"> [{e.fromState ?? "—"} → {e.toState ?? "—"}]</span> : null}
              {" · "}{e.actor}{e.note ? ` — ${e.note}` : ""} · <span dir="ltr">{e.createdAt.slice(0, 19)}</span>
            </li>
          ))}
          {events.length === 0 && <li>رویدادی ثبت نشده است.</li>}
        </ul>
      </section>
    </div>
  );
}
