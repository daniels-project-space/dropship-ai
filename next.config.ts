import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Multiple lockfiles exist on this box (/home/ubuntu + project). Pin the
  // workspace root to this project so Turbopack resolves from here.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
