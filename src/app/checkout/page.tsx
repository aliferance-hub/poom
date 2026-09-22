import Link from "next/link";
import { getCartView } from "@/lib/cart";
import { validateCartForCheckout } from "@/lib/checkout";
import { getSessionId } from "@/lib/session";
import { formatToman, toPersianDigits } from "@/lib/persian";
import { startCheckoutAction } from "@/app/actions";
import { getVehicleWithVariants } from "@/lib/catalog";

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const sid = await getSessionId();
  const view = await getCartView(sid);
  const vehicle = await getVehicleWithVariants("Peugeot", "206");
  const variant = vehicle?.variants.find((v) => v.trim === "تیپ ۵") ?? vehicle?.variants[0];
  const validation = await validateCartForCheckout(sid, variant?.id);

  const sellers = new Set(view.lines.map((l) => l.offer.sellerId));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">تسویه سفارش</h1>

      {error && (
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error.split(" | ").map((e, i) => <p key={i}>✕ {e}</p>)}
        </div>
      )}
      {validation.fitmentWarnings.length > 0 && (
        <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {validation.fitmentWarnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-2">
          {view.lines.map((line) => (
            <div key={line.itemId} className="card flex items-center justify-between gap-3 p-3 text-sm">
              <div>
                <span className="font-semibold">{line.offer.part.title}</span>
                <span className="text-black/45"> · {line.offer.seller.businessName}</span>
              </div>
              <div>× {toPersianDigits(line.quantity)} — {formatToman(line.lineTotal)}</div>
            </div>
          ))}
        </div>
        <aside className="card h-fit space-y-3 p-4">
          <div className="text-sm">
            <div className="flex justify-between"><span>تعداد کالا</span><b>{toPersianDigits(view.itemCount)}</b></div>
            <div className="flex justify-between"><span>فروشندگان درگیر</span><b>{toPersianDigits(sellers.size)}</b></div>
            <div className="mt-1 flex justify-between border-t border-black/8 pt-2">
              <span>مبلغ پرداخت</span><b>{formatToman(view.subtotal)}</b>
            </div>
          </div>
          <form action={startCheckoutAction}>
            <input type="hidden" name="variantId" value={variant?.id ?? ""} />
            <button className="btn-primary w-full" disabled={view.lines.length === 0}>
              ایجاد سفارش و پرداخت (Mock)
            </button>
          </form>
          <p className="text-[10px] leading-4 text-black/40">
            موجودی فقط پس از موفقیت پرداخت کاهش می‌یابد (state machine صریح).
          </p>
        </aside>
      </div>
    </div>
  );
}
