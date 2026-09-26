// P2-H (H11): flat ESLint config — Next core-web-vitals ruleset (flat-compat),
// TypeScript-aware, Next/TS files not treated as scripts.
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "scripts/**"] },
  ...compat.extends("next/core-web-vitals"),
];
