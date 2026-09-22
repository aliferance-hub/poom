"use client";

import { useFormStatus } from "react-dom";
import { addToCartAction } from "@/app/actions";

function SubmitBtn({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} className="btn-primary !px-3 !py-1.5 !text-xs disabled:opacity-40">
      {pending ? "..." : "افزودن به سبد"}
    </button>
  );
}

export function AddToCartButton({ offerId, disabled, back }: { offerId: string; disabled?: boolean; back: string }) {
  return (
    <form action={addToCartAction} className="inline">
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="quantity" value="1" />
      <input type="hidden" name="back" value={back} />
      <SubmitBtn disabled={disabled} />
    </form>
  );
}
