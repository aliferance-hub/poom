import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";

const __adminGate = async () => { const a = await requireAdmin(); if (!a) redirect("/login?next=/admin"); return a; };
import { prisma } from "@/lib/prisma";
import { toPersianDigits } from "@/lib/persian";
import { PartActiveToggle } from "@/components/admin/part-active-toggle";
import { PartVerifyButton } from "@/components/admin/part-verify-button";

export default async function AdminPartsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await __adminGate();
  const { q, page } = await searchParams;
  const take = 30;
  const skip = page ? (Number(page) - 1) * take : 0;

  const [parts, total] = await Promise.all([
    prisma.part.findMany({
      where: q ? { OR: [{ title: { contains: q } }, { sku: { contains: q.toUpperCase() } }, { slug: { contains: q.toLowerCase() } }] } : {},
      include: { category: { select: { titleFa: true } }, brand: { select: { name: true } }, _count: { select: { offers: true, fitments: true } } },
      orderBy: { createdAt: "asc" },
      take, skip,
    }),
    prisma.part.count({ where: q ? { OR: [{ title: { contains: q } }, { sku: { contains: q.toUpperCase() } }] } : {} }),
  ]);

  const pages = Math.ceil(total / take);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">مدیریت قطعات ({toPersianDigits(total)})</h1>
        <Link href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</Link>
      </div>

      <form action="/admin/parts" className="flex gap-2">
        <input name="q" defaultValue={q ?? ""} placeholder="جستجو بر اساس نام یا کد…" className="input !py-1.5 !text-xs max-w-xs" aria-label="جستجوی قطعه" />
        <button className="btn-ghost !px-3 !py-1.5 !text-xs">جستجو</button>
      </form>

      <div className="card divide-y divide-black/6">
        {parts.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div className="min-w-0">
              <Link href={`/parts/${p.slug}`} className="font-medium hover:underline">{p.title}</Link>
              <div className="text-[11px] text-black/50" dir="ltr">{p.sku}</div>
              <div className="text-[11px] text-black/45">
                {p.category?.titleFa ?? "بدون دسته"} · {p.brand?.name ?? "بدون برند"} · {toPersianDigits(p._count.offers)} آفر · {toPersianDigits(p._count.fitments)} قانون سازگاری
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge ${p.dataStatus === "DEMO" ? "bg-amber-100 text-amber-700" : p.dataStatus === "VERIFIED" ? "bg-green-100 text-green-800" : "bg-black/6"}`}>
                {p.dataStatus}
              </span>
              <PartVerifyButton partId={p.id} dataStatus={p.dataStatus} />
              <PartActiveToggle partId={p.id} active={p.active} />
            </div>
          </div>
        ))}
      </div>

      {pages > 1 && (
        <div className="flex gap-1">
          {Array.from({ length: pages }, (_, i) => (
            <Link key={i} href={`/admin/parts?page=${i + 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`badge ${skip === i * take ? "bg-[var(--color-accent)] text-white" : "bg-black/5"}`}>
              {toPersianDigits(i + 1)}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
