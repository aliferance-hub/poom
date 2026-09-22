import { z } from "zod";

/**
 * ───────────────────── Seller validation contracts (P2-D) ─────────────────────
 * Zod is the single validation surface; server actions/routes call these.
 * Money = integer IRR (no floats), stock = integer ≥ 0, shipping range ordered.
 */

const intIrr = z
  .number({ message: "قیمت نامعتبر است." })
  .int("قیمت باید عدد صحیح (ریال) باشد.")
  .positive("قیمت باید بزرگ‌تر از صفر باشد.")
  .max(9_000_000_000_000, "قیمت خارج از محدوده مجاز است.");

const intStock = z
  .number({ message: "موجودی نامعتبر است." })
  .int("موجودی باید عدد صحیح باشد.")
  .min(0, "موجودی نمی‌تواند منفی باشد.")
  .max(1_000_000, "موجودی خارج از محدوده مجاز است.");

export const sellerOfferUpdateSchema = z
  .object({
    priceIrr: intIrr,
    stock: intStock,
    sellerSku: z
      .string()
      .trim()
      .max(40, "SKU فروشنده حداکثر ۴۰ کاراکتر است.")
      .regex(/^[\w\-\/.]*$/, "SKU فروشنده فقط شامل حرف، رقم و -/_. می‌تواند باشد.")
      .optional(),
    shippingDaysMin: z
      .number({ message: "حداقل زمان ارسال نامعتبر است." })
      .int()
      .min(0, "حداقل زمان ارسال نمی‌تواند منفی باشد.")
      .max(60),
    shippingDaysMax: z
      .number({ message: "حداکثر زمان ارسال نامعتبر است." })
      .int()
      .min(0)
      .max(90),
    warrantyFa: z.string().trim().max(120, "متن گارانتی حداکثر ۱۲۰ کاراکتر است.").optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.shippingDaysMax >= v.shippingDaysMin, {
    message: "حداکثر زمان ارسال باید بزرگ‌تر یا مساوی حداقل باشد.",
    path: ["shippingDaysMax"],
  });

export type SellerOfferUpdateInput = z.infer<typeof sellerOfferUpdateSchema>;

export const sellerProfileUpdateSchema = z.object({
  businessName: z.string().trim().min(2, "نام فروشگاه حداقل ۲ کاراکتر است.").max(60),
  ownerName: z.string().trim().max(60).optional().or(z.literal("")),
  phone: z
    .string()
    .trim()
    .regex(/^0\d{9,10}$/, "شماره تلفن معتبر نیست (مثال: 02112345678).")
    .optional()
    .or(z.literal("")),
  city: z.string().trim().max(40).optional().or(z.literal("")),
  address: z.string().trim().max(200, "آدرس حداکثر ۲۰۰ کاراکتر است.").optional().or(z.literal("")),
});

export type SellerProfileUpdateInput = z.infer<typeof sellerProfileUpdateSchema>;

/** CSV row contract (§58). `active` accepts 1/0/true/false. */
export const csvRowSchema = z.object({
  seller_sku: z.string().trim().min(1, "seller_sku الزامی است.").max(40, "seller_sku حداکثر ۴۰ کاراکتر است."),
  part_id: z.string().trim().min(1, "part_id الزامی است.").max(40),
  price_irr: intIrr,
  stock: intStock,
  shipping_days_min: z.number().int().min(0).max(60),
  shipping_days_max: z.number().int().min(0).max(90),
  active: z.boolean({ message: "active باید 1/0 یا true/false باشد." }),
  warranty_fa: z.string().trim().max(120).optional(),
});

export type SellerInventoryRow = z.infer<typeof csvRowSchema>;

export function zodFaErrors(error: z.ZodError): string {
  return error.issues.map((i) => i.message).join("؛ ");
}
