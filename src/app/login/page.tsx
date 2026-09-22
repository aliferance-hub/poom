import Link from "next/link";
import { demoLoginAction } from "@/app/seller/login-actions";

/**
 * Demo login page (P2-D). Lists the demo credentials because this is a demo
 * environment — a real login never reveals valid identifiers.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const seller = process.env.SELLER_LOGIN;
  const admin = process.env.ADMIN_LOGIN;
  const errorFa: Record<string, string> = {
    "1": "شماره واردشده با حساب‌های نمایشی هم‌خوان نیست.",
    rate: "تلاش‌های زیاد؛ لطفاً یک دقیقه بعد دوباره امتحان کنید.",
    inactive: "حساب شما غیرفعال است.",
    disabled: "ورود نمایشی در این محیط غیرفعال است.",
  };
  const errorText = error ? (errorFa[error] ?? errorFa["1"]) : null;

  return (
    <div className="mx-auto max-w-md space-y-4 py-10">
      <h1 className="text-xl font-bold">ورود (محیط نمایشی)</h1>
      <div className="card p-4 text-sm text-black/60">
        این ورود نمایشی برای پنل فروشنده است. شماره‌ی نمایشی را وارد کنید؛ سیستم یک جفت‌سازی کوکی امن انجام می‌دهد.
      </div>
      {errorText && (
        <div className="card border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorText}
        </div>
      )}
      <form action={demoLoginAction} className="card space-y-3 p-4">
        <input type="hidden" name="next" value={next ?? "/seller"} />
        <label className="block text-sm">
          شماره موبایل
          <input
            name="phone"
            inputMode="numeric"
            dir="ltr"
            required
            pattern="0\d{9,10}"
            className="input mt-1 w-full"
            placeholder="09012345678"
            aria-describedby="demo-phones"
          />
        </label>
        <button className="btn-ghost w-full" type="submit">ورود</button>
      </form>
      <div id="demo-phones" className="card space-y-1 p-4 text-xs text-black/55" dir="ltr">
        {seller && <div>SELLER_LOGIN: {seller}</div>}
        {admin && <div>ADMIN_LOGIN: {admin}</div>}
      </div>
      <Link href="/" className="btn-ghost block text-center text-sm">بازگشت به فروشگاه</Link>
    </div>
  );
}
