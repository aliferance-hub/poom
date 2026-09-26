"use server";

import { prisma } from "@/lib/prisma";
import { getSessionId } from "@/lib/session";
import { revalidatePath } from "next/cache";

// P3.1: part inquiries (استعلام قطعه) — public, no auth, no session requirement.
// Anti-spam: per-phone weekly cap + honeypot field. Session id is best-effort context.

const PHONE_RE = /^09\d{9}$/;
const WEEKLY_CAP_PER_PHONE = 5;
const NOTE_MAX = 500;
const NAME_MAX = 60;

export type SubmitInquiryResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function submitPartInquiry(formData: FormData): Promise<SubmitInquiryResult> {
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim().slice(0, NOTE_MAX);
  const partSlugRaw = String(formData.get("partSlug") ?? "").trim();
  const partTitleRaw = String(formData.get("partTitle") ?? "").trim();
  // Honeypot: real users never fill this (hidden field). Bots do.
  const trap = String(formData.get("website") ?? "");

  if (trap) return { ok: true, message: "درخواست شما ثبت شد." }; // silently swallow bots

  if (name.length < 2 || name.length > NAME_MAX) {
    return { ok: false, error: "نام را بین ۲ تا ۶۰ حرف وارد کنید." };
  }
  if (!PHONE_RE.test(phone)) {
    return { ok: false, error: "شمارهٔ موبایل معتبر نیست. قالب درست: ۰۹۱۲۳۴۵۶۷۸۹" };
  }

  // Rate cap: at most WEEKLY_CAP_PER_PHONE inquiries per phone in 7 days.
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recent = await prisma.partInquiry.count({
    where: { phone, createdAt: { gte: weekAgo } },
  });
  if (recent >= WEEKLY_CAP_PER_PHONE) {
    return { ok: false, error: "برای این شماره در هفتهٔ گذشته تعداد زیادی درخواست ثبت شده است. لطفاً بعداً تلاش کنید." };
  }

  // partSlug is optional; only keep it when the part actually exists (no dangling refs).
  let partSlug: string | null = null;
  let partTitle: string | null = null;
  if (partSlugRaw) {
    const part = await prisma.part.findUnique({ where: { slug: partSlugRaw }, select: { title: true } });
    if (part) {
      partSlug = partSlugRaw;
      partTitle = part.title;
    }
  }
  if (!partSlug && partTitleRaw) partTitle = partTitleRaw.slice(0, 120);

  let sessionId: string | null = null;
  try {
    sessionId = (await getSessionId()) || null;
  } catch {
    // no cookie yet — fine, inquiry still accepted
  }

  await prisma.partInquiry.create({
    data: { name, phone, note: note || null, partSlug, partTitle, sessionId },
  });

  revalidatePath("/admin/inquiries");
  return { ok: true, message: "درخواست شما ثبت شد. همکاران ما برای هماهنگی تماس می‌گیرند." };
}
