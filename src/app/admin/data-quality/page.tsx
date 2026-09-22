import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";
import { prisma } from "@/lib/prisma";
import { toPersianDigits } from "@/lib/persian";

/**
 * P2-F (F8): data-quality observability for admins. Every check is a real
 * query against the real dataset — no cached statistics.
 * Customers never see this page (requireAdmin gate below).
 */

export default async function AdminDataQualityPage() {
  const a = await requireAdmin();
  if (!a) redirect("/login?next=/admin/data-quality");

  const [
    totalParts,
    partsWithoutMapping,
    partsWithoutFitment,
    mappingsWithoutPart,
    offersOnDeprecated,
    assetsWithoutVersions,
    assetsMissingProvenance,
    unverifiedCount,
    reviewRequiredCount,
    deprecatedCount,
    duplicateIdentifiers,
    conflictingFitmentParts,
  ] = await Promise.all([
    prisma.part.count(),
    // parts (imported or catalog) with no mesh mapping on any version
    prisma.part.findMany({
      where: { active: true, meshMappings: { none: {} } },
      select: { id: true, slug: true, title: true, dataStatus: true },
      take: 50,
    }),
    // active parts with zero fitment rules — compatibility unknown
    prisma.part.findMany({
      where: { active: true, dataStatus: { not: "DEMO" }, fitments: { none: {} } },
      select: { id: true, slug: true, title: true, dataStatus: true },
      take: 50,
    }),
    // mappings pointing at nothing (defensive; FK makes this rare)
    prisma.meshMapping.findMany({
      where: { kind: "part", partId: null },
      select: { id: true, meshName: true, versionId: true },
      take: 50,
    }),
    // live offers on withdrawn parts — must be reviewed
    prisma.offer.findMany({
      where: { active: true, part: { dataStatus: "DEPRECATED" } },
      select: { id: true, price: true, part: { select: { slug: true, title: true } } },
      take: 50,
    }),
    prisma.asset.findMany({ where: { versions: { none: {} } }, select: { assetId: true } }),
    // published (ACTIVE) versions without complete provenance
    prisma.assetVersion.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { licenseType: null }, { licenseType: "UNSPECIFIED" },
          { creator: null }, { acquiredAt: null }, { intendedUsage: null },
        ],
      },
      select: { id: true, version: true, asset: { select: { assetId: true } } },
    }),
    prisma.part.count({ where: { dataStatus: "UNVERIFIED" } }),
    prisma.part.count({ where: { dataStatus: "REVIEW_REQUIRED" } }),
    prisma.part.count({ where: { dataStatus: "DEPRECATED" } }),
    // same external identifier claimed by two different parts
    prisma.$queryRaw<{ type: string; value: string; cnt: bigint }[]>`
      SELECT pi."type", pi."value", COUNT(*) AS cnt
      FROM "PartIdentifier" pi
      GROUP BY pi."type", pi."value"
      HAVING COUNT(DISTINCT pi."partId") > 1
      LIMIT 20`,
    // parts carrying both CONFIRMED and REJECTED rules on the same vehicle
    prisma.$queryRaw<{ slug: string; title: string }[]>`
      SELECT DISTINCT p.slug, p.title
      FROM "Part" p
      JOIN "Fitment" f1 ON f1."partId" = p.id AND f1."fitmentStatus" = 'CONFIRMED'
      JOIN "Fitment" f2 ON f2."partId" = p.id AND f2."fitmentStatus" = 'REJECTED'
      LIMIT 20`,
  ]);

  const Section = ({ title, count, children }: { title: string; count: number; children?: React.ReactNode }) => (
    <div className="card p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className={`badge ${count > 0 ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
          {toPersianDigits(count)}
        </span>
      </div>
      {children}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">کیفیت داده‌ها ({toPersianDigits(totalParts)} قطعه)</h1>
        <Link href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</Link>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Section title="قطعات بدون نگاشت سه‌بعدی" count={partsWithoutMapping.length}>
          <ul className="mt-2 space-y-1 text-xs text-black/60">
            {partsWithoutMapping.slice(0, 8).map((p) => (
              <li key={p.id}>• <Link href={`/parts/${p.slug}`} className="hover:underline">{p.title}</Link> ({p.dataStatus})</li>
            ))}
          </ul>
        </Section>

        <Section title="قطعات فعال بدون قانون سازگاری" count={partsWithoutFitment.length}>
          <ul className="mt-2 space-y-1 text-xs text-black/60">
            {partsWithoutFitment.slice(0, 8).map((p) => (
              <li key={p.id}>• <Link href={`/parts/${p.slug}`} className="hover:underline">{p.title}</Link> ({p.dataStatus})</li>
            ))}
          </ul>
        </Section>

        <Section title="آفر فعال روی قطعه‌ی منسوخ" count={offersOnDeprecated.length}>
          <ul className="mt-2 space-y-1 text-xs text-black/60">
            {offersOnDeprecated.map((o) => (
              <li key={o.id}>• {o.part.title} — <span dir="ltr">{o.price} IRR</span></li>
            ))}
          </ul>
        </Section>

        <Section title="نسخه‌های فعال با provenance ناقص" count={assetsMissingProvenance.length}>
          <ul className="mt-2 space-y-1 text-xs text-black/60" dir="ltr">
            {assetsMissingProvenance.map((v) => (
              <li key={v.id}>• {v.asset.assetId} v{v.version}</li>
            ))}
          </ul>
        </Section>

        <Section title="شناسه‌ی تکراری بین قطعات" count={duplicateIdentifiers.length}>
          <ul className="mt-2 space-y-1 text-xs text-black/60" dir="ltr">
            {duplicateIdentifiers.map((d) => (
              <li key={`${d.type}:${d.value}`}>• {d.type}:{d.value} ×{d.cnt.toString()}</li>
            ))}
          </ul>
        </Section>

        <Section title="قطعات با قانون متضاد (CONFIRMED+REJECTED)" count={conflictingFitmentParts.length}>
          <ul className="mt-2 space-y-1 text-xs text-black/60">
            {conflictingFitmentParts.map((p) => (
              <li key={p.slug}>• {p.title}</li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="card flex flex-wrap gap-2 p-3 text-xs">
        <span className="badge bg-green-100 text-green-800">VERIFIED: {toPersianDigits(unverifiedCount === 0 ? 0 : totalParts - unverifiedCount - reviewRequiredCount - deprecatedCount)}</span>
        <span className="badge bg-amber-100 text-amber-800">REVIEW_REQUIRED: {toPersianDigits(reviewRequiredCount)}</span>
        <span className="badge bg-black/6">UNVERIFIED: {toPersianDigits(unverifiedCount)}</span>
        <span className="badge bg-red-100 text-red-700">DEPRECATED: {toPersianDigits(deprecatedCount)}</span>
      </div>
    </div>
  );
}
