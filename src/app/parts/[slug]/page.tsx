import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

async function prismaVehicle() {
  return prisma.vehicle.findFirst({ where: { make: "Peugeot", model: "206", active: true }, include: { variants: true } });
}
import { getPartBySlug, getRelatedParts, getZonesForVehicle, RELATED_TYPE_FA, IDENTIFIER_TYPE_FA } from "@/lib/catalog";
import { resolveContract } from "@/lib/asset-registry";
import { VehicleViewer } from "@/components/viewer/vehicle-viewer";
import { getOffersForPart, OFFER_SORTS, stockState, stockLabel, type OfferSort } from "@/lib/offers";
import { sellerTrustSummaryFa, sellerVerificationBadgeFa } from "@/lib/seller/seller-trust-label";
import { resolveFitment, fitmentPresentation, fitmentPresentationReason, FITMENT_FA, FITMENT_BADGE } from "@/lib/fitment";
import { getSessionId } from "@/lib/session";
import { getActiveVehicleContext } from "@/lib/vehicle";
import { formatToman, toPersianDigits } from "@/lib/persian";
import { AddToCartButton } from "@/components/add-to-cart-button";
import { InquiryForm } from "@/components/inquiry-form";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ sort?: string; variant?: string; year?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const part = await getPartBySlug(slug);
  return { title: part ? `${part.title} ۲۰۶` : "قطعه", alternates: { canonical: `/parts/${slug}` } };
}

const DATA_STATUS_FA: Record<string, string> = {
  DEMO: "اطلاعات نمایشی",
  VERIFIED: "تأیید شده",
  UNVERIFIED: "تأیید نشده",
  // P2-F.1 (§7): unverified real data must be VISIBLE as such — never a blank badge
  REVIEW_REQUIRED: "در انتظار تأیید",
  DEPRECATED: "منسوخ",
};
const DATA_STATUS_BADGE: Record<string, string> = {
  DEMO: "bg-amber-50 text-amber-700 border border-amber-200",
  VERIFIED: "bg-green-50 text-green-700 border border-green-200",
  UNVERIFIED: "bg-black/5 text-black/60 border border-black/10",
  REVIEW_REQUIRED: "bg-blue-50 text-blue-700 border border-blue-200",
  DEPRECATED: "bg-red-50 text-red-700 border border-red-200",
};

export default async function PartPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { sort, variant, year } = await searchParams;
  const part = await getPartBySlug(slug);
  if (!part) notFound();

  const activeSort: OfferSort = OFFER_SORTS.some((s) => s.key === sort) ? (sort as OfferSort) : "best";
  const [offers, related, vehicle] = await Promise.all([
    getOffersForPart(part.id, activeSort),
    getRelatedParts(part.id),
    prismaVehicle(),
  ]);

  // ── 3D: the part shown in place on the car (contract-driven, ghost context) ──
  const [contract, viewerZones] = vehicle
    ? await Promise.all([resolveContract(vehicle.id), getZonesForVehicle(vehicle.id)])
    : [null, []];
  const focusPartMesh = contract?.parts.find((p) => p.partId === part.id)?.meshName ?? null;

  // ── Fitment via THE engine (single source of compatibility truth) ──
  // Context priority: ?variant=<trim>&year=<year> URL override → active garage
  // vehicle (session) → 3D-flow cookie (poom_variant) → none.
  const cookieStore = await cookies();
  const sid = await getSessionId();
  const garageCtx = await getActiveVehicleContext(sid).catch(() => null);
  const variantTrim = variant ?? garageCtx?.variantLabel ?? cookieStore.get("poom_variant")?.value ?? null;
  const yearNum = year
    ? Number(year)
    : garageCtx?.year ??
      (cookieStore.get("poom_year")?.value ? Number(cookieStore.get("poom_year")!.value) : null);
  const activeVariant = variantTrim && vehicle
    ? vehicle.variants.find((v) => v.trim === variantTrim) ?? null
    : null;

  let fitmentSection: React.ReactNode;
  if (!vehicle) {
    fitmentSection = <div className="text-sm text-black/50">اطلاعات خودروی انتخاب‌شده معتبر نیست.</div>;
  } else if (!activeVariant) {
    fitmentSection = (
      <div className="space-y-2 text-sm">
        <div className="text-black/60">برای بررسی سازگاری، خودروی خود را انتخاب کنید:</div>
        <div className="flex flex-wrap gap-1">
          {vehicle.variants.map((v) => (
            <Link key={v.id} href={`/parts/${part.slug}?variant=${encodeURIComponent(v.trim)}`}
              className="badge bg-black/5 hover:bg-black/10">{v.trim}</Link>
          ))}
        </div>
        <ul className="space-y-1 pt-1">
          {part.fitments.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-xs text-black/55">
              <span className="font-mono" dir="ltr">{f.fitmentStatus}</span>
              <span>۲۰۶ {f.variant?.trim ?? "همه تیپ‌ها"}</span>
              {f.yearFrom != null && <span>({toPersianDigits(f.yearFrom)}–{toPersianDigits(f.yearTo ?? 0)})</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    const result = await resolveFitment(part.id, {
      vehicleId: vehicle.id,
      variantId: activeVariant.id,
      engine: activeVariant.engine,
      transmission: activeVariant.transmission,
      bodyType: vehicle.bodyType,
      year: yearNum,
    });
    fitmentSection = (() => {
      // P2-F.1 (§3): presentation policy — a COMPATIBLE verdict on a part whose
      // catalog data is not verified/demo is presented as REVIEW_REQUIRED.
      const presented = fitmentPresentation(result.status, part.dataStatus) ?? result.status;
      // P2-G audit (HIGH): explanation must match the presented verdict — never
      // the raw «… سازگار است.» engine sentence for an unverified catalog record.
      const presentedReason = fitmentPresentationReason(result.status, part.dataStatus, result.reasonFa);
      return (
      <div className="space-y-2" data-testid="fitment-result" data-status={presented}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${FITMENT_BADGE[presented]}`}>{FITMENT_FA[presented]}</span>
          <span className="text-sm">🚗 پژو ۲۰۶ {activeVariant.trim}</span>
          {yearNum != null && <span className="text-xs text-black/50">سال {toPersianDigits(yearNum)}</span>}
        </div>
        <p className="text-sm text-black/70">{presentedReason}</p>
        {result.bestRule?.fitmentNote && (
          <p className="rounded-lg bg-black/4 p-2 text-xs text-black/60">یادداشت: {result.bestRule.fitmentNote}</p>
        )}
        {!result.conflicting && (
          <div className="text-[11px] text-black/40">
            دلیل فنی: <span dir="ltr" className="font-mono">{result.reason}</span>
          </div>
        )}
      </div>
      );
    })();
  }

  const specs = (part.specificationsJson ?? null) as Record<string, string> | null;
  const category = part.category;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: part.title,
    sku: part.sku,
    brand: { "@type": "Brand", name: part.brand?.name ?? "DEMO" },
    offers: offers.slice(0, 5).map((o) => ({
      "@type": "Offer",
      priceCurrency: "IRR",
      price: o.price,
      availability: o.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      seller: { "@type": "Organization", name: o.seller.businessName },
    })),
  };

  return (
    <div className="space-y-5">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <nav className="text-xs text-black/50" aria-label="breadcrumb">
        <Link href="/" className="hover:underline">قطعات</Link>
        {category && (
          <>
            {" / "}
            {category.parentId && category.parent && (
              <>
                <span className="text-black/40">{category.parent.titleFa}</span>{" / "}
              </>
            )}
            <Link href={`/categories/${category.slug}`} className="hover:underline">{category.titleFa}</Link>
            {" / "}
          </>
        )}
        {part.assembly && (
          <>
            <Link href={`/vehicles/peugeot/206/zone/${part.assembly.zone.key}`} className="hover:underline">
              {part.assembly.zone.title}
            </Link>{" / "}
          </>
        )}
        <span className="text-black/70">{part.title}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{part.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-black/50">
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${DATA_STATUS_BADGE[part.dataStatus]}`}>
              {DATA_STATUS_FA[part.dataStatus]}
            </span>
            <span>کد: <span dir="ltr">{part.sku}</span></span>
            {part.brand && <span>برند: {part.brand.name}</span>}
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <section className="space-y-4">
          {contract && viewerZones.length > 0 && (
            <div className="card overflow-hidden">
              <VehicleViewer
                contract={contract}
                zones={viewerZones.map((z) => ({ key: z.key, title: z.title, description: z.description }))}
                focusPart={focusPartMesh}
              />
              {focusPartMesh && (
                <div className="border-t border-black/8 px-4 py-2 text-[11px] text-black/50">
                  این قطعه در جای خود روی ۲۰۶ — بقیهٔ خودرو به‌صورت شبح نمایش داده شده است. بچرخانید، بزرگ‌نمایی کنید، یا {""}
                  <Link href="/vehicles/peugeot/206" className="text-[var(--color-accent)] underline">کل خودرو را ببینید</Link>.
                </div>
              )}
            </div>
          )}
          <div className="card p-4">
            <h2 className="mb-2 font-semibold">سازگاری با خودرو</h2>
            {fitmentSection}
          </div>

          {(part.technicalDescription || specs) && (
            <div className="card p-4">
              <h2 className="mb-2 font-semibold">مشخصات</h2>
              {part.technicalDescription && <p className="mb-2 text-sm text-black/70">{part.technicalDescription}</p>}
              {specs && (
                <dl className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
                  {Object.entries(specs).map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-black/4 p-2">
                      <dt className="text-black/45">{k}</dt>
                      <dd className="font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}

          {part.identifiers.length > 0 && (
            <div className="card p-4">
              <h2 className="mb-2 font-semibold">شناسه‌ها</h2>
              <div className="flex flex-wrap gap-1">
                {part.identifiers.map((i) => (
                  <span key={i.id} className="badge bg-black/4 font-mono text-[11px]" dir="ltr">
                    {IDENTIFIER_TYPE_FA[i.type] ?? i.type}: {i.value}
                  </span>
                ))}
              </div>
              <div className="mt-1 text-[10px] text-black/35">تمام شناسه‌ها DEMO هستند و به هیچ کد واقعی اشاره نمی‌کنند.</div>
            </div>
          )}

          {/* P3.1: استعلام قطعه — اگر این قطعه نبود یا موجود نبود، بازدیدکننده درخواست تماس ثبت می‌کند */}
          <div className="card p-4" id="inquiry">
            <h2 className="mb-1 font-semibold">پیدا نکردید؟ استعلام بدهید</h2>
            <p className="mb-3 text-xs text-black/55">
              اگر این قطعه موجود نیست یا مدلتان با فهرست سازگاری نمی‌خواند، درخواست تماس بگذارید تا بررسی کنیم.
            </p>
            <InquiryForm partSlug={part.slug} partTitle={part.title} compact />
          </div>

          {related.length > 0 && (
            <div className="card p-4">
              <h2 className="mb-2 font-semibold">قطعات مرتبط</h2>
              <div className="space-y-1">
                {related.map((r) => (
                  <Link key={r.id} href={`/parts/${r.relatedPart.slug}`}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-black/4">
                    <span>{r.relatedPart.title}</span>
                    <span className="badge bg-black/5 text-[10px]">{RELATED_TYPE_FA[r.type] ?? r.type}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="space-y-3">
          <div className="card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">پیشنهاد فروشنده‌ها</h2>
              <div className="flex flex-wrap gap-1">
                {OFFER_SORTS.map((s) => (
                  <Link key={s.key} href={`/parts/${part.slug}?sort=${s.key}${variant ? `&variant=${encodeURIComponent(variant)}` : ""}`}
                    className={`badge ${s.key === activeSort ? "bg-[var(--color-accent)] text-white" : "bg-black/5 hover:bg-black/10"}`}>
                    {s.label}
                  </Link>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {offers.map((o, idx) => {
                const st = stockState(o);
                return (
                  <div key={o.id} className="rounded-lg border border-black/8 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold">{o.seller.businessName}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-black/50">
                          <span>⭐ {toPersianDigits(o.seller.rating.toFixed(1))}</span>
                          <span>· ارسال {toPersianDigits(o.shippingDays)} روز</span>
                          <span className={`badge ${st === "in" ? "bg-green-100 text-green-800" : st === "low" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700"}`}>
                            {stockLabel(st)}
                          </span>
                          {/* P2-G.1: verification badge derived ONLY from authoritative state —
                              an unverified real seller can never wear it (label module enforces). */}
                          {(() => {
                            const badge = sellerVerificationBadgeFa(o.seller);
                            return badge ? <span className={`badge ${badge.className}`}>{badge.text}</span> : null;
                          })()}
                        </div>
                      </div>
                      <div className="text-end">
                        <div className="font-bold">{formatToman(o.price)}</div>
                        {o.compareAtPrice && (
                          <div className="text-[11px] text-black/40 line-through">{formatToman(o.compareAtPrice)}</div>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] text-black/35">
                        {/* P2-G.1: origin + verification derived from authoritative state
                            (DEMO → demo label; REAL_ONBOARDING+UNVERIFIED → real, not verified). */}
                        {sellerTrustSummaryFa(o.seller)}
                        {idx === 0 && activeSort === "best" ? " · بهترین پیشنهاد" : ""}
                      </span>
                      <AddToCartButton offerId={o.id} disabled={o.stock <= 0} back={`/parts/${part.slug}?sort=${activeSort}`} />
                    </div>
                  </div>
                );
              })}
              {offers.length === 0 && <div className="p-4 text-sm text-black/50">فعلاً پیشنهادی برای این قطعه ثبت نشده (DEMO).</div>}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
