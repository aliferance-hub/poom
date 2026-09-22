import Link from "next/link";
import { notFound } from "next/navigation";
import { getAssemblyBySlug } from "@/lib/catalog";

export default async function AssemblyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const assembly = await getAssemblyBySlug(slug);
  if (!assembly) notFound();

  return (
    <div className="space-y-4">
      <nav className="text-xs text-black/50" aria-label="breadcrumb">
        <Link href="/" className="hover:underline">خانه</Link> /{" "}
        <Link href="/vehicles/peugeot/206/type-5" className="hover:underline">پژو ۲۰۶</Link> /{" "}
        <Link href={`/vehicles/peugeot/206/zone/${assembly.zone.key}`} className="hover:underline">{assembly.zone.title}</Link> /{" "}
        {assembly.title}
      </nav>

      <h1 className="text-xl font-bold">{assembly.title}</h1>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {assembly.parts.map((p) => (
          <Link key={p.id} href={`/parts/${p.slug}`} className="card p-4 hover:shadow-md">
            <div className="font-semibold">{p.title}</div>
            {/* P2-F (F9): the badge reflects the part's real data status — synthetic
                rows are DEMO, imported rows show their verification state. */}
            <div className="mt-1 text-[11px] text-black/45">
              {p.dataStatus === "DEMO" ? "DEMO" : p.dataStatus === "VERIFIED" ? "تأیید شده" : "در انتظار تأیید"} · {p.sku}
            </div>
          </Link>
        ))}
        {assembly.parts.length === 0 && (
          <div className="card p-6 text-sm text-black/50">قطعه‌ای در این اسمبلی ثبت نشده است.</div>
        )}
      </div>
    </div>
  );
}
