/**
 * Engineering-style side-view blueprint of the 206 — pure SVG, zero JS.
 * Drawn from the SAME dimension basis as the 3D model (wheelbase 2435mm,
 * H=1425mm, tires 185/55R15), so the 2D and 3D representations agree.
 * Scale: 100px = 1m · ground at y=170 · front of car at +x.
 */
import { toPersianDigits } from "@/lib/persian";

export function Blueprint206({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 500 200" className={className} role="img"
      aria-label="نقشهٔ مهندسی پژو ۲۰۶ — نمای جانبی با فاصلهٔ محوری ۲٬۴۳۵ میلی‌متر">
      {/* wheelbase dimension line */}
      <g stroke="rgba(255,255,255,.30)" strokeWidth="1">
        <line x1="139" y1="176" x2="382" y2="176" />
        <line x1="139" y1="170" x2="139" y2="182" />
        <line x1="382" y1="170" x2="382" y2="182" />
      </g>
      <text x="260" y="192" textAnchor="middle" fontSize="11"
        fill="rgba(255,255,255,.65)">{toPersianDigits("۲٬۴۳۵")} mm</text>

      {/* body silhouette (206 hatch profile) */}
      <path
        d="M70,128 L66,98 L74,72 L110,31.5 L232,27.5 L302,60 L402,71.5 L436,83 L440,115 L434,130 Z"
        fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="1.6" strokeLinejoin="round"
      />
      {/* glasshouse */}
      <path d="M120,42 L228,35 L294,60 L120,66 Z" fill="none" stroke="rgba(255,255,255,.40)" strokeWidth="1" />
      {/* hood + hatch shut lines */}
      <line x1="298" y1="63" x2="304" y2="76" stroke="rgba(255,255,255,.28)" strokeWidth="1" />
      <line x1="106" y1="70" x2="120" y2="92" stroke="rgba(255,255,255,.28)" strokeWidth="1" />
      {/* wheels 185/55R15 (r≈28.5px) + hubs */}
      <g fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="1.6">
        <circle cx="139" cy="141.5" r="28.5" />
        <circle cx="139" cy="141.5" r="12" stroke="rgba(255,255,255,.45)" strokeWidth="1" />
        <circle cx="382" cy="141.5" r="28.5" />
        <circle cx="382" cy="141.5" r="12" stroke="rgba(255,255,255,.45)" strokeWidth="1" />
      </g>
      {/* axle crosshairs */}
      <g stroke="rgba(255,255,255,.35)" strokeWidth="1">
        <path d="M133,141.5 h12 M139,135.5 v12" />
        <path d="M376,141.5 h12 M382,135.5 v12" />
      </g>
      {/* ground line */}
      <line x1="40" y1="170" x2="470" y2="170" stroke="rgba(255,255,255,.25)" strokeWidth="1" />
    </svg>
  );
}
