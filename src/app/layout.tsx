import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getSessionId } from "@/lib/session";
import { getCartView } from "@/lib/cart";
import { getActiveVehicleContext, vehicleContextLabel } from "@/lib/vehicle";
import { toPersianDigits } from "@/lib/persian";
import { CartBadge } from "@/components/cart-badge";

export const metadata: Metadata = {
  title: { default: "پوم | قطعه را روی ماشینت پیدا کن", template: "%s | پوم" },
  description: "مارکت‌پلیس نمایشی قطعات یدکی با کشف بصری سه‌بعدی — داده‌ها همگی DEMO هستند.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const sid = await getSessionId();
  const [cart, activeVehicle] = await Promise.all([
    getCartView(sid).catch(() => null),
    getActiveVehicleContext(sid).catch(() => null),
  ]);

  return (
    <html lang="fa" dir="rtl">
      <body className="min-h-screen">
        <header className="sticky top-0 z-40 border-b border-black/8 bg-[var(--color-graphite)] text-white">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
            <Link href="/" className="flex items-center gap-2 font-bold">
              <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-accent)]">پ</span>
              <span>پوم</span>
            </Link>
            <nav className="hidden items-center gap-4 text-sm text-white/80 md:flex">
              <Link href="/vehicles/peugeot/206" className="hover:text-white">پژو ۲۰۶</Link>
              <Link href="/search" className="hover:text-white">جستجو</Link>
              <Link href="/seller" className="hover:text-white">پنل فروشنده</Link>
              <Link href="/admin" className="hover:text-white">ادمین</Link>
            </nav>
            <div className="ms-auto flex items-center gap-3">
              <Link href="/account/garage" className="hidden text-xs text-white/75 hover:text-white sm:inline">
                {activeVehicle ? (
                  <>خودروی من: <b className="text-white">{vehicleContextLabel(activeVehicle)}</b></>
                ) : (
                  "خودروی خود را انتخاب کنید"
                )}
              </Link>
              <Link href="/cart" className="relative rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15">
                سبد خرید
                <CartBadge initial={cart?.itemCount ?? 0} />
              </Link>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>

        <footer className="mt-10 border-t border-black/8 bg-white py-6 text-center text-xs text-black/50">
          <p>
            محیط نمایشی (MVP) — تمام قطعات، فروشنده‌ها، قیمت‌ها و موجودی‌ها <b>DEMO</b> هستند و هیچ داده واقعی
            OEM/قیمت/ضمانتی در این نسخه وجود ندارد.
          </p>
        </footer>
      </body>
    </html>
  );
}
