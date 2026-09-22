// Persian normalization for search (ي→ی، ك→ک، digits, ZWNJ, punctuation, spacing)
const ARABIC_YA = /\u064A/g;
const ARABIC_KAF = /\u0643/g;
const ARABIC_HAMZA_ALEF = /[\u0623\u0625\u0622]/g;
const ZWNJ = /\u200C/g;
const MULTI_WS = /\s+/g;
const PUNCT = /[.,،؛;:!؟?«»"'\-–_\(\)\[\]{}]/g;
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function toEnglishDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

export function toPersianDigits(s: string | number): string {
  return String(s).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}

/** Normalize any Persian/Arabic-mixed query to a canonical comparable form. */
export function normalizeFa(input: string): string {
  let s = String(input ?? "");
  s = toEnglishDigits(s);
  s = s.replace(ARABIC_YA, "ی").replace(ARABIC_KAF, "ک");
  s = s.replace(ARABIC_HAMZA_ALEF, "ا");
  s = s.replace(ZWNJ, " "); // نیم‌فاصله → فاصله
  s = s.replace(PUNCT, " ");
  s = s.replace(MULTI_WS, " ").trim().toLowerCase();
  return s;
}

/** Money: canonical integer IRR → display Toman with fa digits. */
export function irrToToman(irr: number): string {
  return toPersianDigits(Math.round(irr / 10).toLocaleString("en-US"));
}

export function formatToman(irr: number): string {
  return `${irrToToman(irr)} تومان`;
}

/**
 * Fallback session id generator (middleware is the primary issuer).
 * Kept for server contexts where middleware has not run yet.
 */
export function newSessionId(): string {
  return `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
