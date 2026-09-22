import Link from "next/link";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { toPersianDigits } from "@/lib/persian";

const LINKS: [string, string][] = [
  ["/seller", "داشبورد"],
  ["/seller/offers", "آفرها"],
  ["/seller/inventory", "موجودی"],
  ["/seller/orders", "سفارش‌ها"],
  ["/seller/profile", "پروفایل"],
];

export async function SellerNav() {
  const identity = await getAuthenticatedSeller();
  if (!identity) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-2 p-4">
        <div className="text-sm text-black/60">برای دسترسی به پنل فروشنده وارد شوید.</div>
        <Link href="/login?next=/seller" className="btn-ghost">ورود فروشنده</Link>
      </div>
    );
  }
  return (
    <nav aria-label="پنل فروشنده" className="card flex flex-wrap items-center gap-1 p-2 text-sm">
      <span className="ml-2 px-2 font-bold">{identity.seller.businessName}</span>
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} className="btn-ghost !px-3 !py-1.5">{label}</Link>
      ))}
      <span className="grow" />
      <span className="badge bg-black/6">امتیاز نمایشی: {toPersianDigits(identity.seller.rating.toFixed(1))}</span>
      <form action="/api/seller/logout" method="post">
        <button className="btn-ghost !px-3 !py-1.5" type="submit">خروج</button>
      </form>
    </nav>
  );
}
