"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  assignMeshAction, unassignMeshAction, updateMappingMetaAction,
  activateVersionAction, rollbackVersionAction, processVersionAction,
} from "@/app/studio-actions";

type VersionRow = {
  id: string; version: number; status: string;
  fileSize: number | null; mimeType: string | null; checksum: string | null;
  licenseType: string | null; commercialUse: boolean; mappingCount: number;
  acquiredAt: string | null; // ISO — null/missing = incomplete provenance
  provenanceComplete: boolean; // F1: license+creator+acquiredAt+intendedUsage all present
};

type Props = {
  asset: { assetId: string; source: string; versions: VersionRow[] };
  zones: { id: string; label: string }[];
  assemblies: { id: string; label: string }[];
  parts: { id: string; label: string }[];
};

const FA_STATUS: Record<string, string> = {
  DRAFT: "پیش‌نویس", PROCESSING: "در حال پردازش", READY: "آماده",
  ACTIVE: "فعال", ARCHIVED: "بایگانی", REJECTED: "رد شده",
};

/** Demo geometry mirroring the viewer (mesh names are the stable contract). */
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
          onClick={(e) => { e.stopPropagation(); onSelect(b.name); }}
          onPointerMissed={() => onSelect(null)}
        >
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

export function MappingStudio({ asset, zones, assemblies, parts }: Props) {
  const activeVersion = asset.versions.find((v) => v.status === "ACTIVE") ?? asset.versions[0];
  const [selectedVersionId, setSelectedVersionId] = useState(activeVersion?.id ?? "");
  const [selectedMesh, setSelectedMesh] = useState<string | null>(null);
  const [kind, setKind] = useState<"zone" | "assembly" | "part">("zone");
  const [targetId, setTargetId] = useState(zones[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const orbitRef = useRef<any>(null);

  const options = kind === "zone" ? zones : kind === "assembly" ? assemblies : parts;

  const captureCamera = () => {
    const cam = orbitRef.current?.object as THREE.PerspectiveCamera | undefined;
    const target = orbitRef.current?.target as THREE.Vector3 | undefined;
    if (!cam || !target || !selectedMesh) return;
    const pos = [+cam.position.x.toFixed(3), +cam.position.y.toFixed(3), +cam.position.z.toFixed(3)];
    const tgt = [+target.x.toFixed(3), +target.y.toFixed(3), +target.z.toFixed(3)];
    start(async () => {
      await updateMappingMetaAction({ versionId: selectedVersionId, meshName: selectedMesh, cameraPosition: pos, cameraTarget: tgt });
      setMessage(`دوربین برای ${selectedMesh} ثبت شد`);
    });
  };

  const saveExploded = (axis: "x" | "y" | "z") => {
    if (!selectedMesh) return;
    const offset = axis === "y" ? [0, 1.2, 0] : axis === "x" ? [1.2, 0, 0] : [0, 0, 1.2];
    start(async () => {
      await updateMappingMetaAction({ versionId: selectedVersionId, meshName: selectedMesh, explodedOffset: offset });
      setMessage(`انفجار ${selectedMesh}: +${offset.join(",")}`);
    });
  };

  const upload = async (form: HTMLFormElement) => {
    const fd = new FormData(form);
    setMessage("در حال بارگذاری…");
    const res = await fetch(`/api/admin/assets/${asset.assetId}/upload`, { method: "POST", body: fd });
    const j = await res.json();
    setMessage(res.ok ? `نسخه ${j.version} ساخته شد (${j.status}) — checksum ${String(j.checksum).slice(0, 12)}…` : `خطا: ${j.error}`);
    if (res.ok) setTimeout(() => location.reload(), 1200);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">استودیو نگاشت سه‌بعدی</h1>
          <span className="font-mono text-xs text-black/50" dir="ltr">{asset.assetId}</span>
        </div>
        <a href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</a>
      </div>

      {/* versions + upload */}
      <section className="card p-4 space-y-3">
        <h2 className="font-semibold">نسخه‌ها</h2>
        <div className="flex flex-wrap gap-2">
          {asset.versions.map((v) => (
            <button key={v.id} onClick={() => setSelectedVersionId(v.id)}
              className={`badge ${v.id === selectedVersionId ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>
              v{v.version} · {FA_STATUS[v.status] ?? v.status} · {v.mappingCount} نگاشت
            </button>
          ))}
        </div>
        <div className="text-[11px] text-black/50">
          {activeVersion?.checksum && <span dir="ltr">SHA-256: {activeVersion.checksum.slice(0, 16)}… · </span>}
          {activeVersion?.licenseType ? <span>مجوز: {activeVersion.licenseType} · استفاده تجاری: {activeVersion.commercialUse ? "بله" : "خیر"}</span> : "بدون مجوز ثبت‌شده"}
          {activeVersion && (
            <span className="ms-2 inline-block rounded px-1.5 py-0.5 text-[10px]"
              style={{ background: activeVersion.provenanceComplete ? "#dcfce7" : "#fef3c7", color: activeVersion.provenanceComplete ? "#166534" : "#92400e" }}>
              {activeVersion.provenanceComplete ? "provenance کامل" : "provenance ناقص — انتشار رد می‌شود"}
            </span>
          )}
          {activeVersion?.acquiredAt && <span dir="ltr" className="ms-1">· acquired {activeVersion.acquiredAt.slice(0, 10)}</span>}
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={pending || !selectedVersionId}
            onClick={() => start(async () => {
              const proc = await processVersionAction(selectedVersionId);
              if (!proc.ok) { setMessage(`خطا: ${(proc.problems ?? [proc.error ?? "پردازش ناموفق"]).join("، ")}`); return; }
              const act = await activateVersionAction(selectedVersionId);
              setMessage(act.ok ? "نسخه فعال شد (publish)" : `خطا: ${act.error}`);
            })}>
            انتشار (فعال‌سازی)
          </button>
          <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={pending || !selectedVersionId}
            onClick={() => start(async () => {
              const res = await rollbackVersionAction(selectedVersionId);
              setMessage(res.ok ? "به این نسخه rollback شد" : `خطا: ${res.error}`);
            })}>
            Rollback به این نسخه
          </button>
        </div>

        <form action={(fd) => upload(fd as unknown as HTMLFormElement)} className="space-y-2 rounded-lg border border-dashed border-black/15 p-3" data-testid="upload-form">
          <div className="text-xs font-semibold">بارگذاری GLB جدید (نسخه DRAFT ساخته می‌شود)</div>
          <input type="file" name="file" accept=".glb,model/gltf-binary" required className="input !py-1 !text-xs" />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <input name="licenseType" placeholder="licenseType (مثلا CC-BY-4.0)" className="input !py-1 !text-xs" dir="ltr" />
            <input name="licenseUrl" placeholder="licenseUrl" className="input !py-1 !text-xs" dir="ltr" />
            <input name="sourceUrl" placeholder="sourceUrl" className="input !py-1 !text-xs" dir="ltr" />
            <input name="creator" placeholder="creator" className="input !py-1 !text-xs" dir="ltr" />
            <input name="attributionText" placeholder="attributionText" className="input !py-1 !text-xs" />
            <select name="commercialUse" className="input !py-1 !text-xs" defaultValue="false">
              <option value="false">استفاده تجاری: خیر</option>
              <option value="true">استفاده تجاری: بله</option>
            </select>
            <input type="date" name="acquiredAt" className="input !py-1 !text-xs" dir="ltr" title="تاریخ تهیه فایل (F1: الزامی برای asset واقعی)" />
            <input name="intendedUsage" placeholder="intendedUsage (مثلا product-viewer)" className="input !py-1 !text-xs" dir="ltr" />
            <input name="modifications" placeholder="modifications (تغییرات اعمال‌شده)" className="input !py-1 !text-xs" />
          </div>
          <button className="btn-ghost !px-3 !py-1.5 !text-xs" type="submit">بارگذاری و اعتبارسنجی</button>
        </form>
        {message && <div className="rounded-lg bg-blue-50 p-2 text-xs text-blue-800" data-testid="studio-message">{message}</div>}
      </section>

      {/* scene + inspector */}
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <section className="card overflow-hidden">
          <div className="h-[420px] w-full" role="img" aria-label="نمای سه‌بعدی استودیو نگاشت — برای انتخاب مش روی بدنه خودرو کلیک کنید" title="استودیو نگاشت سه‌بعدی">
            <Canvas dpr={[1, 2]} camera={{ position: [6.5, 3.2, 7.5], fov: 45 }}
              onPointerMissed={() => setSelectedMesh(null)}>
              <color attach="background" args={["#f6f7f9"]} />
              <ambientLight intensity={0.75} />
              <directionalLight position={[5, 8, 4]} intensity={1.1} />
              <DemoMeshes onSelect={setSelectedMesh} selected={selectedMesh} />
              <OrbitControls makeDefault ref={orbitRef} enablePan={false} />
            </Canvas>
          </div>
          <div className="border-t border-black/8 p-2 text-center text-[11px] text-black/50">
            روی مش کلیک کنید تا انتخاب شود · نام مش = شناسه پایدار نگاشت
          </div>
        </section>

        <aside className="card space-y-3 p-4" data-testid="inspector">
          <h2 className="font-semibold">بازرس مش</h2>
          <div className="rounded-lg bg-black/4 p-2 font-mono text-xs" dir="ltr">
            {selectedMesh ?? "— mesh انتخاب نشده —"}
          </div>

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
                  onClick={() => start(async () => {
                    await assignMeshAction({ versionId: selectedVersionId, meshName: selectedMesh, kind, targetId, label: label || undefined });
                    setMessage(`${selectedMesh} → ${kind} ذخیره شد`);
                  })}>
                  ذخیره نگاشت
                </button>
                <button className="btn-ghost !px-2 !py-1 !text-xs" disabled={pending} onClick={captureCamera}>
                  ثبت دوربین فعلی
                </button>
                <button className="btn-ghost !px-2 !py-1 !text-xs" disabled={pending} onClick={() => saveExploded("y")}>
                  انفجار +Y
                </button>
                <button className="btn-ghost !px-2 !py-1 !text-xs !text-red-600" disabled={pending}
                  onClick={() => start(async () => {
                    await unassignMeshAction(selectedVersionId, selectedMesh);
                    setMessage(`${selectedMesh} حذف شد`);
                  })}>
                  حذف نگاشت
                </button>
              </div>
            </>
          )}
          <p className="text-[10px] leading-4 text-black/40">
            نگاشت‌ها روی نسخه انتخابی ذخیره می‌شوند (MeshMapping.versionId). کاتالوگ و فروش بدون تغییر می‌مانند.
          </p>
        </aside>
      </div>
    </div>
  );
}
