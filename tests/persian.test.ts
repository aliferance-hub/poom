import { describe, expect, it } from "vitest";
import { normalizeFa, toEnglishDigits, toPersianDigits, formatToman } from "@/lib/persian";

describe("normalizeFa — Persian search normalization", () => {
  it("maps Arabic ya/kaf to Persian forms", () => {
    expect(normalizeFa("لنت ترمز عربي كد")).toBe(normalizeFa("لنت ترمز عربی کد"));
  });

  it("unifies Persian and Arabic-Indic digits with English digits", () => {
    expect(normalizeFa("لنت ۲۰۶")).toBe(normalizeFa("لنت 206"));
    expect(normalizeFa("لنت ٢٠٦")).toBe(normalizeFa("لنت 206"));
  });

  it("treats نیم‌فاصله and extra whitespace as plain spaces", () => {
    expect(normalizeFa("لنت\u200Cترمز")).toBe(normalizeFa("لنت ترمز"));
    expect(normalizeFa("  لنت    ترمز  ")).toBe(normalizeFa("لنت ترمز"));
  });

  it("the PRD example set collapses to the same key", () => {
    const a = normalizeFa("لنت ترمز 206");
    expect(normalizeFa("لنت ترمز ۲۰۶")).toBe(a);
    expect(normalizeFa("لنت ۲۰۶")).not.toBe(a); // fewer terms → different key (documented behavior)
    expect(normalizeFa("لنت 206")).toBe(normalizeFa("لنت ۲۰۶"));
    expect(normalizeFa("brake pad 206")).toBe("brake pad 206");
  });

  it("strips punctuation", () => {
    expect(normalizeFa("لنت، ترمز!")).toBe(normalizeFa("لنت ترمز"));
  });
});

describe("digits & money", () => {
  it("converts digits both ways", () => {
    expect(toEnglishDigits("۲۰۶")).toBe("206");
    expect(toPersianDigits(206)).toBe("۲۰۶");
  });

  it("formats IRR → Toman with fa digits", () => {
    expect(formatToman(3980000)).toBe("۳۹۸,۰۰۰ تومان");
  });
});
