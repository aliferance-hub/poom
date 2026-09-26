import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // P2-H (H11): ESLint now runs during builds (was disabled at MVP). Flat
  // config lives in eslint.config.mjs; baseline is 0 errors / 1 documented
  // intentional warning. Keep the build red on real lint regressions.
  eslint: { ignoreDuringBuilds: false },
  experimental: {
    // keep server actions default; no special flags needed for MVP
  },
};

export default nextConfig;
