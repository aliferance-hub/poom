import Link from "next/link";
import { getCartView } from "@/lib/cart";
import { getSessionId } from "@/lib/session";
import { formatToman, toPersianDigits } from "@/lib/persian";
import { updateCartItemAction, removeCartItemAction } from "@/app/actions";
import { getVehicleWithVariants } from "@/lib/catalog";
import { sellerOriginLabelFa } from "@/lib/seller/seller-trust-label";

export default async function CartPage() {
  const sid = await getSessionId();
  const view = await getCartView(sid);
  const vehicle = await getVehicleWithVariants("Peugeot", "206");
  const variant = vehicle?.variants.find((v) => v.trim === "تیپ ۵") ?? vehicle?.variants[0];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">سبد خرید</h1>

      {view.errors.length > 0 && (
        <div className="card border-[var(--color-warn)]/30 bg-amber-50 p-4 text-sm text-amber-900">
          {view.errors.map((e, i) => <p key={i}>⚠ {e}</p>)}
        </div>
      )}

      {view.lines.length === 0 ? (
        <div className="card p-8 text-center text-sm text-black/50">
          سبد خرید خالی است. <Link href="/vehicles/peugeot/206/type-5" className="text-[var(--color-accent)] hover:underline">قطعه انتخاب کنید</Link>.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-2">
            {view.lines.map((line) => (
              <div key={line.itemId} className="card flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-40 flex-1">
                  <Link href={`/parts/${line.offer.part.slug}`} className="font-semibold hover:underline">
                    {line.offer.part.title}
                  </Link>
                  <div className="mt-0.5 text-[11px] text-black/50">
                    {/* P2-G.1 fix (audit M-4): origin label is derived from authoritative
                        state — the real seller's cart line no longer claims "DEMO". */}
                    {line.offer.seller.businessName} · {sellerOriginLabelFa(line.offer.seller)} · {formatToman(line.unitPrice)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <form action={updateCartItemAction} className="flex items-center gap-1">
                    <input type="hidden" name="itemId" value={line.itemId} />
                    <input type="number" name="quantity" min={1} max={line.offer.stock} defaultValue={line.quantity}
                      className="input !w-16 text-center" aria-label="تعداد" />
                    <button className="btn-ghost !px-2 !py-1 !text-xs">به‌روزرسانی</button>
                  </form>
                  <form action={removeCartItemAction}>
                    <input type="hidden" name="itemId" value={line.itemId} />
                    <button className="btn-ghost !px-2 !py-1 !text-xs !text-red-600">حذف</button>
                  </form>
                </div>
                <div className="w-28 text-end font-bold">{formatToman(line.lineTotal)}</div>
              </div>
            ))}
          </div>

          <aside className="card h-fit space-y-3 p-4">
            <div className="flex justify-between text-sm">
              <span>جمع کل ({toPersianDigits(view.itemCount)} کالا)</span>
              <b>{formatToman(view.subtotal)}</b>
            </div>
            <form action="/checkout" method="get">
              <input type="hidden" name="variant" value={variant?.id ?? ""} />
              <button className="btn-primary w-full">ادامه و پرداخت</button>
            </form>
            <p className="text-[10px] leading-4 text-black/40">
              پرداخت در این نسخه Mock است و پول واقعی جابه‌جا نمی‌شود. همه داده‌ها DEMO هستند.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
