import { redirect } from "next/navigation";
import { getSessionId } from "@/lib/session";
import { getCurrentUser } from "@/lib/auth/identity";
import { getReturnEligibility } from "@/lib/returns";
import { submitReturnAction } from "@/app/account/return-actions";
import { formatToman } from "@/lib/persian";

export const dynamic = "force-dynamic";

export default async function NewReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string; error?: string }>;
}) {
  const sp = await searchParams;
  if (!sp.item) redirect("/account/orders");
  const sid = await getSessionId();
  const user = await getCurrentUser();
  const owner = { sessionId: sid, userId: user?.id };

  const eligibility = await getReturnEligibility(sp.item, owner);
  if (!eligibility.eligible) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8">
        <h1 className="text-xl font-bold">درخواست مرجوعی</h1>
        <div className="card border border-red-300 bg-red-50 p-3 text-sm text-red-900" role="alert">{eligibility.reason}</div>
      </div>
    );
  }

  const errorFa: Record<string, string> = {
    ELIGIBILITY: "این قلم در حال حاضر قابل مرجوع شدن نیست.",
    RATE_LIMITED: "تلاش‌های زیاد؛ کمی بعد دوباره امتحان کنید.",
    INVALID: "اطلاعات ارسالی نامعتبر است.",
  };

  return (
    <div className="mx-auto max-w-lg space-y-4 py-8">
      <h1 className="text-xl font-bold">درخواست مرجوعی</h1>
      <div className="card space-y-1 p-4 text-sm">
        <p>مهلت مرجوعی این سفارش: <b>{eligibility.windowDays} روز</b> پس از تحویل.</p>
        {eligibility.noteFa && <p className="text-xs text-black/50">{eligibility.noteFa}</p>}
      </div>
      {sp.error && (
        <div className="card border border-red-300 bg-red-50 p-2 text-sm text-red-900" role="alert">{errorFa[sp.error] ?? "خطا"}</div>
      )}
      <form action={submitReturnAction} className="card space-y-3 p-4">
        <input type="hidden" name="orderItemId" value={sp.item} />
        <label className="block text-sm">
          دلیل مرجوعی
          <textarea name="reason" required minLength={3} maxLength={500} rows={3} className="input mt-1 w-full" placeholder="مثلاً: کالا با سفارش هم‌خوان نیست" />
        </label>
        <label className="block text-sm">
          توضیح بیشتر (اختیاری)
          <textarea name="notes" maxLength={500} rows={2} className="input mt-1 w-full" />
        </label>
        <button className="btn-ghost w-full" type="submit">ثبت درخواست</button>
      </form>
    </div>
  );
}
