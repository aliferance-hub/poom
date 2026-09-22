"use client";

import { useState, useTransition } from "react";
import { updateSellerOfferAction } from "@/app/admin-actions";
import { formatToman, toPersianDigits } from "@/lib/persian";

type OfferRow = {
  id: string;
  price: number;
  stock: number;
  active: boolean;
  partTitle: string;
  partSku: string;
};

export function SellerOfferRow({ offer }: { offer: OfferRow }) {
  const [price, setPrice] = useState(String(offer.price));
  const [stock, setStock] = useState(String(offer.stock));
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
      <div className="min-w-40 flex-1">
        <div className="font-medium">{offer.partTitle}</div>
        <div className="text-[10px] text-black/40" dir="ltr">{offer.partSku}</div>
      </div>
      <div className="flex items-end gap-2">
        <label className="text-[10px] text-black/45">
          قیمت (ریال)
          <input value={price} onChange={(e) => setPrice(e.target.value)} className="input !w-28 !py-1" dir="ltr" />
        </label>
        <label className="text-[10px] text-black/45">
          موجودی
          <input value={stock} onChange={(e) => setStock(e.target.value)} className="input !w-16 !py-1" dir="ltr" />
        </label>
        <button
          className="btn-ghost !px-2 !py-1 !text-xs"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await updateSellerOfferAction(offer.id, Number(price), Number(stock));
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
            })
          }
        >
          {pending ? "..." : saved ? "ذخیره شد ✓" : "ذخیره"}
        </button>
      </div>
    </div>
  );
}
