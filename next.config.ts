import type { NextConfig } from "next";
import { API_CSP, STATIC_SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Prisma driver adapter and pg must stay server-side and unbundled.
  serverExternalPackages: ["@prisma/adapter-pg", "pg", "pino"],
  // Pages get their nonce CSP from proxy.ts; these apply to every response.
  async headers() {
    return [
      { source: "/:path*", headers: STATIC_SECURITY_HEADERS },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: API_CSP }] },
      // The service worker must always be revalidated so fixes reach installed apps.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ];
  },
};

export default nextConfig;
