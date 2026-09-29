import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Prisma driver adapter and pg must stay server-side and unbundled.
  serverExternalPackages: ["@prisma/adapter-pg", "pg", "pino"],
};

export default nextConfig;
