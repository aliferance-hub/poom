import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";

const __adminGate = async () => { const a = await requireAdmin(); if (!a) redirect("/login?next=/admin"); return a; };
import { prisma } from "@/lib/prisma";
import { toPersianDigits } from "@/lib/persian";

export default async function AdminCategoriesPage() {
  await __adminGate();
  const [cats, counts] = await Promise.all([
    prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }], include: { parent: { select: { titleFa: true } } } }),
    prisma.part.groupBy({ by: ["categoryId"], _count: { _all: true } }),
  ]);
  const countBy = new Map(counts.map((c) => [c.categoryId, c._count._all]));

  const roots = cats.filter((c) => !c.parentId);
  const childrenOf = (id: string) => cats.filter((c) => c.parentId === id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">درخت دسته‌بندی ({toPersianDigits(cats.length)})</h1>
        <Link href="/admin" className="btn-ghost !px-2 !py-1 !text-xs">بازگشت به ادمین</Link>
      </div>

      <div className="card space-y-3 p-4">
        {roots.map((r) => (
          <div key={r.id}>
            <div className="flex items-center gap-2 font-semibold">
              <span className="text-sm">{r.titleFa}</span>
              <span className="badge bg-black/5 text-[10px]">{toPersianDigits(countBy.get(r.id) ?? 0)}</span>
              <span className="font-mono text-[10px] text-black/35" dir="ltr">{r.slug}</span>
            </div>
            <div className="mt-1 space-y-1 border-r border-black/10 pr-4">
              {childrenOf(r.id).map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-sm text-black/70">
                  <span>— {c.titleFa}</span>
                  <span className="badge bg-black/5 text-[10px]">{toPersianDigits(countBy.get(c.id) ?? 0)}</span>
                  {childrenOf(c.id).map((g) => (
                    <span key={g.id} className="text-xs text-black/50">· {g.titleFa} ({toPersianDigits(countBy.get(g.id) ?? 0)})</span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
