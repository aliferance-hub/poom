"use client";

import { useMemo, useState, useEffect, useRef, Suspense, Component, type ReactNode } from "react";
import { Canvas, useFrame, useLoader, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, useProgress } from "@react-three/drei";
import { useRouter, useSearchParams } from "next/navigation";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { AssetContractV2 } from "@/lib/asset-registry";
import type { ZoneInfo } from "./vehicle-viewer";

const ACCENT = "#1668e3";
type CamVec = [number, number, number];
type ViewMode = "full" | "isolated" | "exploded";

function cameraFor(contract: AssetContractV2 | null, zoneKey: string | null, focusPart?: string | null): { pos: CamVec; target: CamVec } {
  const DEFAULT = { pos: [6.5, 3.2, 7.5] as CamVec, target: [0, 0.7, 0] as CamVec };
  if (!contract) return DEFAULT;
  // Focus-part mode (PDP): frame the part itself.
  if (focusPart) {
    const part = contract.parts.find((p) => p.meshName === focusPart);
    if (part?.hotspot) {
      const [hx, hy, hz] = part.hotspot;
      return { pos: [hx + 1.9, hy + 0.95, hz + 1.9], target: [hx, hy, hz] };
    }
  }
  if (!zoneKey) return DEFAULT;
  const z = contract.zones.find((x) => x.zoneKey === zoneKey);
  return z ? { pos: z.camera.position, target: z.camera.target } : DEFAULT;
}

/** Contract-driven mesh: zone geometry derived from mapping data, not hard-coded. */
function ContractMesh({
  meshName, position, size, color, kind,
  highlight, dimmed, hidden, explodedOffset, explodeFactor,
  onOver, onOut, onClick,
}: {
  meshName: string; position: CamVec; size: CamVec; color: string;
  kind: "zone" | "part"; highlight: boolean; dimmed: boolean; hidden?: boolean;
  explodedOffset: CamVec | null; explodeFactor: number;
  onOver?: (e: ThreeEvent<PointerEvent>) => void;
  onOut?: (e: ThreeEvent<PointerEvent>) => void;
  onClick?: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const ref = useMemo(() => {
    const off = explodedOffset ?? [0, 0, 0];
    return {
      base: new THREE.Vector3(...position),
      offset: new THREE.Vector3(...off).multiplyScalar(explodeFactor),
    };
  }, [position, explodedOffset, explodeFactor]);

  const targetPos = useMemo(
    () => ref.base.clone().add(ref.offset),
    [ref],
  );
  const current = useRef(new THREE.Vector3(...position));
  current.current.lerp(targetPos, 0.25);

  return (
    <mesh name={meshName} position={current.current.toArray()} userData={{ kind }}
      visible={!hidden}
      onPointerOver={onOver} onPointerOut={onOut} onClick={onClick}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={highlight ? ACCENT : color}
        transparent={dimmed}
        opacity={dimmed ? 0.12 : 1}
        roughness={0.55}
        metalness={0.15}
      />
    </mesh>
  );
}

/** Hotspot marker for mapped part meshes — always visible, occlusion-free depthTest off. */
function Hotspot({ position, label, onClick }: { position: CamVec; label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <mesh position={position}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = "pointer"; }}
      onPointerOut={() => { setHovered(false); document.body.style.cursor = "auto"; }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <sphereGeometry args={[0.09, 16, 16]} />
      <meshBasicMaterial color={hovered ? "#0ea5e9" : ACCENT} depthTest={false} transparent opacity={0.95} />
      {hovered && (
        <sprite position={[0, 0.25, 0]} scale={[1.6, 0.4, 1]}>
          <spriteMaterial depthTest={false} />
        </sprite>
      )}
    </mesh>
  );
}

function CameraRig({ contract, activeZone, focusPart, resetSignal, reduced }: {
  contract: AssetContractV2 | null; activeZone: string | null; focusPart?: string | null; resetSignal: number; reduced: boolean;
}) {
  const camera = useThreeSafeCamera();
  const controls = useThreeSafeControls();
  const dest = useMemo(() => cameraFor(contract, activeZone, focusPart ?? undefined), [contract, activeZone, focusPart, resetSignal]);
  const moving = useRef(false);
  useEffect(() => { moving.current = true; }, [dest, resetSignal]);
  useFrame(() => {
    if (!moving.current) return;
    const k = reduced ? 1 : 0.08;
    camera.position.lerp(new THREE.Vector3(...dest.pos), k);
    if (controls && "target" in controls) {
      (controls as unknown as { target: THREE.Vector3 }).target.lerp(new THREE.Vector3(...dest.target), k);
    }
    if (reduced || (camera.position.distanceTo(new THREE.Vector3(...dest.pos)) < 0.05)) moving.current = false;
  });
  return null;
}

function useThreeSafeCamera() { return useThree((s) => s.camera); }
function useThreeSafeControls() { return useThree((s) => s.controls); }

/** Real upload progress → the overlay bar (no-op for the builtin placeholder). */
function LoadTracker({ onProgress }: { onProgress: (pct: number) => void }) {
  const { progress } = useProgress();
  useEffect(() => { onProgress(Math.round(progress)); }, [progress, onProgress]);
  return null;
}

/**
 * P2-F (F1): real model layer. Renders the ACTIVE asset version's GLB alongside
 * placeholders; meshes found in the file (matched by sanitized name) replace
 * their placeholder, which stays as the honest fallback for anything missing.
 * Draco-compressed files fetch the decoder from the standard CDN at load time.
 */
function RealModel({
  url, contract, explodeFactor, isDimmed, focusPart, onResolved,
  interactionsFor, explodeOffsetFor,
}: {
  url: string;
  contract: AssetContractV2;
  explodeFactor: number;
  isDimmed: (meshName: string) => boolean;
  focusPart?: string | null;
  onResolved: (found: string[], missing: string[]) => void;
  interactionsFor: (meshName: string) => {
    onOver: (e: ThreeEvent<PointerEvent>) => void;
    onOut: (e: ThreeEvent<PointerEvent>) => void;
    onClick: (e: ThreeEvent<MouseEvent>) => void;
  };
  explodeOffsetFor: (meshName: string) => CamVec | null;
}) {
  const gltf = useLoader(GLTFLoader, url, (loader) => {
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
    (loader as GLTFLoader).setDRACOLoader(draco);
  }) as GLTF;

  useEffect(() => {
    if (!gltf?.scene) return;
    const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });

    const wanted: string[] = [
      ...contract.zones.map((z) => z.meshName),
      ...contract.parts.map((p) => p.meshName),
    ];
    const found: string[] = [];
    const missing: string[] = [];
    for (const name of wanted) {
      const target = sanitize(name);
      const exact = meshes.find((m) => sanitize(m.name) === target);
      const fuzzy = meshes.find((m) => {
        const n = sanitize(m.name);
        return n !== "" && n !== target && (n.includes(target) || target.includes(n));
      });
      (exact ?? fuzzy ? found : missing).push(name);
    }
    onResolved(found, missing);
  }, [gltf, contract, onResolved]);

  const resolved = useMemo(() => {
    if (!gltf?.scene) return [];
    const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const wanted: string[] = [
      ...contract.zones.map((z) => z.meshName),
      ...contract.parts.map((p) => p.meshName),
    ];
    const out: { name: string; node: THREE.Object3D }[] = [];
    for (const name of wanted) {
      const target = sanitize(name);
      const exact = meshes.find((m) => sanitize(m.name) === target);
      const fuzzy = meshes.find((m) => {
        const n = sanitize(m.name);
        return n !== "" && n !== target && (n.includes(target) || target.includes(n));
      });
      const hit = exact ?? fuzzy;
      if (hit) {
        const node = hit.clone(true);
        // Per-mesh material clones: the GLB ships one shared material, and ghost
        // mode must set opacity independently per contract mesh.
        node.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.material = Array.isArray(mesh.material)
              ? mesh.material.map((mm) => mm.clone())
              : mesh.material.clone();
          }
        });
        out.push({ name, node });
      }
    }
    return out;
  }, [gltf, contract]);

  // Ghost appearance: in focus mode every mesh except the focused part fades to
  // 10% opacity (the part stays solid) — applied imperatively to the clones.
  const appearance = useMemo(() => {
    const spec: Record<string, "solid" | "ghost"> = {};
    for (const { name } of resolved) {
      spec[name] =
        (focusPart != null && name !== focusPart) || isDimmed(name) ? "ghost" : "solid";
    }
    return spec;
  }, [resolved, focusPart, isDimmed]);

  useEffect(() => {
    for (const { name, node } of resolved) {
      const ghost = appearance[name] === "ghost";
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const std = m as THREE.MeshStandardMaterial;
          std.transparent = ghost;
          std.opacity = ghost ? 0.10 : 1;
          std.depthWrite = !ghost;
        }
      });
    }
  }, [resolved, appearance]);

  return (
    <group>
      {resolved.map(({ name, node }) => {
        const it = interactionsFor(name);
        const off = explodeOffsetFor(name);
        const pos: CamVec = [
          (off?.[0] ?? 0) * explodeFactor,
          (off?.[1] ?? 0) * explodeFactor,
          (off?.[2] ?? 0) * explodeFactor,
        ];
        return (
          <group key={name} position={pos}
            onPointerOver={it.onOver} onPointerOut={it.onOut} onClick={it.onClick}>
            <primitive object={node} />
          </group>
        );
      })}
    </group>
  );
}

/** Real-GLB failures must never blank the viewer: fall back to placeholders. */
class GlbErrorBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) {
    console.warn("[viewer] real GLB failed — placeholder fallback", err);
    this.props.onFail(); // commit phase → safe to update the parent
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/**
 * Scene geometry: derives from the contract's zoneKey via a data table of
 * placeholder shapes. P2-F (F1): when the active asset version carries a real
 * GLB (fileUrl not builtin:*), matching meshes are replaced by the loaded model
 * and unmatched meshes keep their placeholders — commerce never depends on this.
 */
function placeholderShape(meshName: string): { position: CamVec; size: CamVec; color: string; kind: "zone" | "part" } {
  const table: Record<string, { position: CamVec; size: CamVec; color: string; kind: "zone" | "part" }> = {
    zone_body: { position: [0, 0.95, 0.1], size: [1.7, 0.55, 3.4], color: "#9aa3b2", kind: "zone" },
    zone_engine: { position: [0, 0.72, 1.15], size: [1.1, 0.5, 0.7], color: "#6b7280", kind: "zone" },
    zone_cooling: { position: [0, 0.62, 1.62], size: [1.15, 0.6, 0.1], color: "#4b5563", kind: "zone" },
    zone_wheels: { position: [0.85, 0.34, 1.15], size: [0.24, 0.68, 0.68], color: "#1c1d22", kind: "zone" },
    zone_brakes: { position: [0.62, 0.34, 1.15], size: [0.1, 0.3, 0.3], color: "#ef4444", kind: "zone" },
    zone_suspension: { position: [0.5, 0.2, 1.15], size: [0.22, 0.2, 0.5], color: "#64748b", kind: "zone" },
    zone_electrical: { position: [-0.45, 0.95, 1.2], size: [0.35, 0.25, 0.25], color: "#111827", kind: "zone" },
    zone_interior: { position: [0, 1.35, -0.4], size: [1.3, 0.15, 0.5], color: "#334155", kind: "zone" },
    part_radiator_main: { position: [0, 0.62, 1.62], size: [1.15, 0.6, 0.1], color: "#4b5563", kind: "part" },
    part_oil_filter_main: { position: [0.62, 0.45, 1.3], size: [0.16, 0.32, 0.16], color: "#f59e0b", kind: "part" },
    part_brake_pad_front_main: { position: [0.62, 0.34, 1.15], size: [0.1, 0.3, 0.3], color: "#ef4444", kind: "part" },
    part_battery_main: { position: [-0.45, 0.95, 1.2], size: [0.35, 0.25, 0.25], color: "#111827", kind: "part" },
    part_floor_mat_main: { position: [0, 1.12, -0.35], size: [1.2, 0.04, 1.2], color: "#0f172a", kind: "part" },
  };
  return table[meshName] ?? { position: [99, 99, 99], size: [0.1, 0.1, 0.1], color: "#cccccc", kind: "part" };
}

export function CarScene({
  contract, zones, focusPart, onWebglFail,
}: {
  contract: AssetContractV2 | null;
  zones: ZoneInfo[];
  focusPart?: string | null;
  onWebglFail?: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeZone, setActiveZone] = useState<string | null>(searchParams.get("zone"));
  const [hovered, setHovered] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("full");
  const [loadingProgress, setLoadingProgress] = useState(100);
  const containerRef = useRef<HTMLDivElement>(null);

  // P2-F (F1) real-model state
  const realUrl = contract?.fileUrl && !contract.fileUrl.startsWith("builtin:") ? contract.fileUrl : null;
  const [glbFailed, setGlbFailed] = useState(false);
  const [realFound, setRealFound] = useState<Set<string>>(new Set());
  const [realMissing, setRealMissing] = useState<string[]>([]);

  const reduced =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const zoneTitle = (key: string) => zones.find((z) => z.key === key)?.title ?? key;

  // Deep-link sync: ?zone=cooling
  useEffect(() => {
    const z = searchParams.get("zone");
    setActiveZone(z);
  }, [searchParams]);

  const selectZone = (k: string) => {
    const next = activeZone === k ? null : k;
    setActiveZone(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("zone", next); else url.searchParams.delete("zone");
    window.history.replaceState(null, "", url.toString());
  };

  const zoneKeys = useMemo(() => new Set(contract?.zones.map((z) => z.zoneKey) ?? []), [contract]);
  const partByMesh = useMemo(() => new Map((contract?.parts ?? []).map((p) => [p.meshName, p])), [contract]);

  const over = (k: string) => (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(k); document.body.style.cursor = "pointer"; };
  const out = () => (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(null); document.body.style.cursor = "auto"; };

  const hot = (k: string) => hovered === k || activeZone === k || (focusPart != null && (k === focusPart || k === focusPart.replace("part_", "zone_")));
  // PDP focus mode: the whole car is context — ghost everything except the focused part.
  const ghostAll = (meshKey: string) =>
    focusPart != null && meshKey !== focusPart;
  const isDimmed = (meshKey: string) =>
    viewMode === "isolated" && activeZone !== null &&
    meshKey !== `zone_${activeZone}` && !partByMesh.has(meshKey) &&
    !(meshKey.startsWith("part_") && meshKey.includes(activeZone));

  const handleMeshClick = (meshName: string) => {
    const part = partByMesh.get(meshName);
    if (part?.partSlug) { router.push(`/parts/${part.partSlug}`); return; }
    const zk = meshName.replace("zone_", "");
    if (zoneKeys.has(zk)) selectZone(zk);
  };

  // Shared interaction plumbing for both placeholder and real meshes
  const interactionsFor = (meshName: string) => {
    const part = partByMesh.get(meshName);
    const key = part ? meshName : meshName.replace("zone_", "");
    return {
      onOver: over(key),
      onOut: out(),
      onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); handleMeshClick(meshName); },
    };
  };
  const explodeOffsetFor = (meshName: string): CamVec | null => {
    const shape = placeholderShape(meshName);
    const part = partByMesh.get(meshName);
    return part?.hotspot
      ? [(part.hotspot[0] - shape.position[0]) * 0.6, 0.6, (part.hotspot[2] - shape.position[2]) * 0.6]
      : [0, meshName.startsWith("zone_") ? 0.5 : 1.1, 0];
  };

  const onRealResolved = useMemo(() => (found: string[], missing: string[]) => {
    setRealFound(new Set(found));
    setRealMissing(missing);
  }, []);

  const visibleEntries = useMemo(() => {
    const all: { meshName: string; zoneKey: string | null }[] = [];
    for (const z of contract?.zones ?? []) all.push({ meshName: z.meshName, zoneKey: z.zoneKey });
    for (const p of contract?.parts ?? []) {
      const owner = contract?.zones.find((z) => z.meshName.replace("zone_", "") === p.meshName.replace("part_", ""))?.zoneKey ?? null;
      all.push({ meshName: p.meshName, zoneKey: owner });
    }
    return all;
  }, [contract]);

  const explodeFactor = viewMode === "exploded" ? 1 : 0;

  return (
    <div ref={containerRef} className="relative h-[420px] w-full overflow-hidden rounded-xl border border-black/8 bg-white md:h-[520px]" data-testid="viewer">
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [6.5, 3.2, 7.5], fov: 45 }}
        fallback={<div className="grid h-full place-items-center text-sm text-black/50">WebGL در دسترس نیست — از فهرست نواحی استفاده کنید.</div>}
        onCreated={({ gl }) => { gl.domElement.addEventListener("webglcontextlost", () => onWebglFail?.()); }}
      >
        <color attach="background" args={["#f6f7f9"]} />
        <ambientLight intensity={0.75} />
        <directionalLight position={[5, 8, 4]} intensity={1.1} />
        <directionalLight position={[-6, 4, -4]} intensity={0.35} />
        <group position={[0, -0.15, 0]}>
          {visibleEntries.map(({ meshName }) => {
            const shape = placeholderShape(meshName);
            const part = partByMesh.get(meshName);
            const key = part ? meshName : meshName.replace("zone_", "");
            return (
              <ContractMesh
                key={meshName}
                meshName={meshName}
                position={shape.position}
                size={shape.size}
                color={shape.color}
                kind={part ? "part" : "zone"}
                highlight={hot(key)}
                dimmed={ghostAll(meshName) || isDimmed(meshName)}
                hidden={realFound.has(meshName)} // real GLB replaces its placeholder
                explodedOffset={explodeOffsetFor(meshName)}
                explodeFactor={explodeFactor}
                onOver={interactionsFor(meshName).onOver}
                onOut={interactionsFor(meshName).onOut}
                onClick={interactionsFor(meshName).onClick}
              />
            );
          })}
          {/* P2-F (F1): real model layer — Suspense + hard fallback to placeholders */}
          {realUrl && contract && !glbFailed && (
            <GlbErrorBoundary onFail={() => setGlbFailed(true)}>
              <Suspense fallback={null}>
                <RealModel
                  url={realUrl}
                  contract={contract}
                  explodeFactor={explodeFactor}
                  isDimmed={isDimmed}
                  focusPart={focusPart}
                  onResolved={onRealResolved}
                  interactionsFor={interactionsFor}
                  explodeOffsetFor={explodeOffsetFor}
                />
              </Suspense>
            </GlbErrorBoundary>
          )}
          {/* hotspot markers for mapped parts */}
          {viewMode !== "exploded" && (contract?.parts ?? []).filter((p) => p.hotspot && p.partSlug).map((p) => (
            <Hotspot key={p.meshName} position={p.hotspot!} label={p.label ?? ""}
              onClick={() => router.push(`/parts/${p.partSlug}`)} />
          ))}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]}>
            <circleGeometry args={[7, 48]} />
            <meshStandardMaterial color="#eceef2" />
          </mesh>
        </group>
        <CameraRig contract={contract} activeZone={activeZone} focusPart={focusPart} resetSignal={resetSignal} reduced={!!reduced} />
        {realUrl && <LoadTracker onProgress={setLoadingProgress} />}
        <OrbitControls makeDefault enablePan={false} minDistance={2.5} maxDistance={16} maxPolarAngle={Math.PI / 2.05} />
        <GizmoHelper alignment="bottom-left" margin={[64, 64]}>
          <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="white" />
        </GizmoHelper>
      </Canvas>

      {/* overlay controls */}
      <div className="absolute left-3 top-3 flex flex-wrap gap-1">
        <button onClick={() => { setActiveZone(null); setViewMode("full"); setResetSignal((s) => s + 1); }}
          className="badge bg-white/90 shadow hover:bg-white">بازنشانی نما</button>
        <button onClick={() => void containerRef.current?.requestFullscreen?.()}
          className="badge bg-white/90 shadow hover:bg-white" aria-label="تمام‌صفحه">تمام‌صفحه</button>
        {activeZone && (
          <button onClick={() => setViewMode((m) => (m === "isolated" ? "full" : "isolated"))}
            className={`badge shadow ${viewMode === "isolated" ? "bg-[var(--color-accent)] text-white" : "bg-white/90 hover:bg-white"}`}>
            {viewMode === "isolated" ? "خروج از ایزوله" : "نمایش ایزوله"}
          </button>
        )}
        <button onClick={() => setViewMode((m) => (m === "exploded" ? "full" : "exploded"))}
          className={`badge shadow ${viewMode === "exploded" ? "bg-[var(--color-accent)] text-white" : "bg-white/90 hover:bg-white"}`}
          aria-pressed={viewMode === "exploded"}>
          نمای انفجاری
        </button>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-white/85 px-3 py-1 text-[11px] text-black/60 shadow">
        {hovered ? zoneTitle(hovered) ?? hovered : "بچرخانید · روی ناحیه یا قطعه کلیک کنید"}
      </div>
      {activeZone && (
        <div className="absolute right-3 top-3 w-56 rounded-lg bg-white/95 p-3 text-sm shadow" data-testid="zone-panel">
          <div className="font-semibold">{zoneTitle(activeZone)}</div>
          <div className="mt-2 flex flex-col gap-1">
            <button onClick={() => router.push(`/vehicles/peugeot/206/zone/${activeZone}`)} className="btn-primary !px-2 !py-1 !text-xs">
              مشاهده قطعات این ناحیه
            </button>
            <button onClick={() => selectZone(activeZone)} className="btn-ghost !px-2 !py-1 !text-xs">بستن</button>
          </div>
        </div>
      )}
      {/* P2-F (F1): honest model-source + attribution line */}
      <div className="pointer-events-none absolute bottom-3 right-3 max-w-[45%] text-right text-[10px] leading-4 text-black/45">
        {realUrl && !glbFailed ? (
          realMissing.length === 0 && realFound.size > 0 ? (
            <>مدل واقعی نسخهٔ {contract?.versionNumber} · {contract?.license.attributionText ?? ""}</>
          ) : (
            <>مدل واقعی (جزئی) + نمونهٔ جایگزین</>
          )
        ) : realUrl && glbFailed ? (
          <>بارگذاری مدل واقعی ناموفق بود — نمایش با نمونهٔ جایگزین</>
        ) : (
          <>نمونهٔ جایگزین (asset واقعی ثبت نشده است)</>
        )}
      </div>
      {loadingProgress < 100 && (
        <div className="absolute inset-x-0 top-0 h-1 bg-black/5">
          <div className="h-full bg-[var(--color-accent)]" style={{ width: `${loadingProgress}%` }} />
        </div>
      )}
    </div>
  );
}
