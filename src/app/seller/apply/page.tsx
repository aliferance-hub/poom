import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { getCurrentUser } from "@/lib/auth/identity";
import { ApplyForm } from "./apply-form";

export const metadata = { title: "ثبت‌نام فروشنده | پوم" };

export default async function SellerApplyPage() {
  const seller = await getAuthenticatedSeller();
  if (seller) redirect("/seller"); // already a seller
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/seller/apply");

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <h1 className="text-xl font-bold">ثبت‌نام فروشنده واقعی</h1>
      <p className="text-sm text-black/60">
        با ثبت این فرم، درخواست شما در وضعیت «در انتظار بررسی» قرار می‌گیرد. پس از تأیید ادمین
        می‌توانید روی قطعات واقعی کاتالوگ آفر منتشر کنید.
      </p>
      <ApplyForm />
      <Link href="/" className="btn-ghost !px-3 !py-1.5 !text-xs">بازگشت به فروشگاه</Link>
    </div>
  );
}
