import { redirect } from "next/navigation";
import { SellerNav } from "@/components/seller/seller-nav";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { prisma } from "@/lib/prisma";
import { ProfileForm } from "@/components/seller/profile-form";
import { toPersianDigits } from "@/lib/persian";

export const dynamic = "force-dynamic";

export default async function SellerProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const identity = await getAuthenticatedSeller();
  if (!identity) redirect("/login?next=/seller/profile");
  const sp = await searchParams;

  const seller = await prisma.seller.findUniqueOrThrow({
    where: { id: identity.seller.id },
    select: {
      businessName: true, ownerName: true, phone: true, city: true, address: true,
      status: true, sellerOrigin: true, sellerVerificationStatus: true, verifiedAt: true, verificationActor: true,
      rating: true, responseRate: true,
    },
  });

  return (
    <div className="space-y-4">
      <SellerNav />
      <h1 className="text-xl font-bold">پروفایل فروشگاه</h1>

      <div className="card space-y-1 p-4 text-sm">
        <h2 className="text-sm font-semibold">فیلدهای سیستمی (فقط مدیریت)</h2>
        <div className="text-black/60">
          {/* P2-G.1: origin + verification are system-controlled; shown read-only. */}
          منشأ: <span className="badge bg-black/6">{seller.sellerOrigin === "REAL_ONBOARDING" ? "ثبت‌نام واقعی" : seller.sellerOrigin === "SYSTEM" ? "سیستمی" : "نمایشی"}</span>
          {" · "}وضعیت تأیید: <b>{seller.sellerVerificationStatus === "VERIFIED" ? "تأیید شده در سیستم" : seller.sellerVerificationStatus === "PENDING_REVIEW" ? "در انتظار بررسی" : seller.sellerVerificationStatus === "REJECTED" ? "رد شده" : "تأیید نشده"}</b>
          {seller.verifiedAt && <>{" · "}آخرین تصمیم: {toPersianDigits(seller.verifiedAt.toISOString().slice(0, 10))}</>}
          {" · "}وضعیت فروشگاه: <span className="badge bg-black/6">{seller.status}</span>
          {" · "}امتیاز: {toPersianDigits(seller.rating.toFixed(1))}
          {seller.responseRate != null && <>{" · "}نرخ پاسخ‌دهی: {toPersianDigits(Math.round(seller.responseRate * 100))}٪</>}
        </div>
        <p className="text-[11px] text-black/45">این مقادیر توسط فروشنده قابل تغییر نیستند؛ منشأ، وضعیت تأیید و امتیاز فقط توسط مدیریت یا سیستم تعیین می‌شود.</p>
      </div>

      {sp.saved && <div className="card border border-green-300 bg-green-50 p-2 text-sm text-green-900" role="status">پروفایل ذخیره شد.</div>}

      <ProfileForm
        initial={{
          businessName: seller.businessName,
          ownerName: seller.ownerName ?? "",
          phone: seller.phone ?? "",
          city: seller.city ?? "",
          address: seller.address ?? "",
        }}
      />
    </div>
  );
}
