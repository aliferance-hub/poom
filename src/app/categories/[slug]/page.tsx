import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCategoryBySlug, getPartsForCategoryTree } from "@/lib/catalog";
import { formatToman, toPersianDigits } from "@/lib/persian";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const cat = await getCategoryBySlug(slug);
  return {
    title: cat ? `${cat.titleFa} — قطعات ۲۰۶` : "دسته‌بندی",
    alternates: { canonical: `/categories/${slug}` },
  };
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  if (!category || !category.active) notFound();

  const parts = await getPartsForCategoryTree(category.id);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "قطعات", item: "/" },
      ...(category.parent ? [{ "@type": "ListItem", position: 2, name: category.parent.titleFa, item: `/categories/${category.parent.slug}` }] : []),
      { "@type": "ListItem", position: category.parent ? 3 : 2, name: category.titleFa, item: `/categories/${category.slug}` },
    ],
  };

  return (
    <div className="space-y-4">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <nav className="text-xs text-black/50" aria-label="breadcrumb">
        <Link href="/" className="hover:underline">قطعات</Link>
        {category.parent && (<>{" / "}<Link href={`/categories/${category.parent.slug}`} className="hover:underline">{category.parent.titleFa}</Link></>)}
        {" / "}<span className="text-black/70">{category.titleFa}</span>
      </nav>

      <div>
        <h1 className="text-xl font-bold">{category.titleFa}</h1>
        {category.descriptionFa && <p className="mt-1 text-sm text-black/55">{category.descriptionFa}</p>}
      </div>

      {category.children.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {category.children.map((c) => (
            <Link key={c.id} href={`/categories/${c.slug}`} className="badge bg-black/5 hover:bg-black/10">
              {c.titleFa} <span className="text-black/40">({toPersianDigits(c._count?.parts ?? 0)})</span>
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {parts.map((p) => (
          <Link key={p.id} href={`/parts/${p.slug}`} className="card p-3 transition hover:shadow">
            <div className="text-sm font-semibold">{p.title}</div>
            <div className="mt-1 flex items-center justify-between text-xs text-black/50">
              <span>{p.brand?.name ?? "بدون برند (DEMO)"}</span>
              <span>{p._count.offers > 0 ? `${toPersianDigits(p._count.offers)} پیشنهاد` : "بدون پیشنهاد"}</span>
            </div>
          </Link>
        ))}
        {parts.length === 0 && <div className="card p-4 text-sm text-black/50">قطعه‌ای در این دسته ثبت نشده (DEMO).</div>}
      </div>
    </div>
  );
}
