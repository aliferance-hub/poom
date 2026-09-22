import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // R3F/three ship modern ESM that next handles fine, but keep strict defaults.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // keep server actions default; no special flags needed for MVP
  },
};

export default nextConfig;
