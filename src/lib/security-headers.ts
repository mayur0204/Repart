/**
 * Security headers (PLAN.md §9 M13 "security review (headers/CSP)").
 *
 * Pages get a per-request nonce CSP from proxy.ts (Next.js applies the nonce to its own scripts during dynamic
 * rendering). Everything else gets the static headers from next.config.ts.
 *
 * Origins, and why each is here:
 * - storage origin (SUPABASE_URL or MINIO_ENDPOINT): photos are shown and uploaded through short-lived signed URLs
 *   on that host (img-src, connect-src).
 * - sdk.cashfree.com: the Cashfree v3 checkout script (pay-form.tsx).
 * - sandbox.cashfree.com: the hosted checkout the SDK sends the buyer to (CASHFREE_ENV is sandbox-only, env-schema.ts).
 * style-src keeps 'unsafe-inline' because React renders style attributes (the progress bar width); scripts never do.
 */
export const CASHFREE_SDK_ORIGIN = "https://sdk.cashfree.com";
export const CASHFREE_CHECKOUT_ORIGIN = "https://sandbox.cashfree.com";

/** Origin of a configured URL, or null when unset or malformed. Never returns a path, query or credentials. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(opts: { nonce: string; storageOrigins: (string | null)[]; dev: boolean; https: boolean }): string {
  const storage = [...new Set(opts.storageOrigins.filter((o): o is string => !!o))];
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${opts.nonce}' 'strict-dynamic' ${CASHFREE_SDK_ORIGIN}${opts.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data: blob:", ...storage].join(" "),
    "font-src 'self' data:",
    ["connect-src 'self'", ...storage, CASHFREE_SDK_ORIGIN, CASHFREE_CHECKOUT_ORIGIN].join(" "),
    `frame-src ${CASHFREE_SDK_ORIGIN} ${CASHFREE_CHECKOUT_ORIGIN}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${CASHFREE_CHECKOUT_ORIGIN}`,
    "frame-ancestors 'none'",
  ];
  if (opts.https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Headers for every response (next.config.ts). HSTS is only honoured over HTTPS, so it is harmless on local HTTP. */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/** API responses are JSON/CSV only: nothing on them should ever load or be framed. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
