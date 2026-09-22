"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/persian";
import { useCartCount } from "@/store/cart-count";

export function CartBadge({ initial }: { initial: number }) {
  const count = useCartCount((s) => s.count);
  const setCount = useCartCount((s) => s.set);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    let alive = true;
    fetch("/api/cart")
      .then((r) => r.json())
      .then((d: { itemCount?: number }) => alive && typeof d.itemCount === "number" && setCount(d.itemCount))
      .catch(() => {});
    const onFocus = () => {
      fetch("/api/cart").then((r) => r.json()).then((d: { itemCount?: number }) => {
        if (alive && typeof d.itemCount === "number") setCount(d.itemCount);
      }).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => { alive = false; window.removeEventListener("focus", onFocus); };
  }, [mounted, setCount]);

  const shown = mounted ? count : initial;
  if (shown <= 0) return null;
  return (
    <span className="absolute -left-2 -top-2 grid size-5 place-items-center rounded-full bg-[var(--color-accent)] text-[10px] font-bold text-white">
      {toPersianDigits(shown)}
    </span>
  );
}
