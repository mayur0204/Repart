import { describe, expect, it } from "vitest";
import { API_CSP, contentSecurityPolicy, originOf, STATIC_SECURITY_HEADERS } from "@/lib/security-headers";
import nextConfig from "../../next.config";

const directives = (csp: string) => Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

describe("content security policy", () => {
  const csp = contentSecurityPolicy({ nonce: "abc123", storageOrigins: ["https://proj.supabase.co", null], dev: false, https: true });
  const d = directives(csp);

  it("allows scripts only by nonce (plus the Cashfree SDK), never inline or eval in production", () => {
    expect(d["script-src"]).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'", "https://sdk.cashfree.com"]);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("locks down everything else and names each third-party origin explicitly", () => {
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["worker-src"]).toEqual(["'self'"]); // strict-dynamic would otherwise block the service worker
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:", "https://proj.supabase.co"]);
    expect(d["connect-src"]).toEqual(["'self'", "https://proj.supabase.co", "https://sdk.cashfree.com", "https://sandbox.cashfree.com"]);
    expect(d["frame-src"]).toEqual(["https://sdk.cashfree.com", "https://sandbox.cashfree.com"]);
    expect(d["form-action"]).toEqual(["'self'", "https://sandbox.cashfree.com"]);
    expect(csp).not.toMatch(/\s\*(\s|;|$)|https:\s|http:\s/); // no wildcard or bare scheme sources
    expect(d["upgrade-insecure-requests"]).toEqual([]);
  });

  it("adds eval only in development and skips the HTTPS upgrade on plain HTTP", () => {
    const dev = contentSecurityPolicy({ nonce: "n", storageOrigins: [], dev: true, https: false });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("uses only the origin of a storage URL, so nothing secret can leak into the header", () => {
    expect(originOf("https://user:pass@proj.supabase.co/storage/v1?token=x")).toBe("https://proj.supabase.co");
    expect(originOf("not a url")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe("static headers", () => {
  it("sets nosniff, referrer policy, frame denial, permissions policy and HSTS", () => {
    const h = Object.fromEntries(STATIC_SECURITY_HEADERS.map((x) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Permissions-Policy"]).toMatch(/microphone=\(\).*geolocation=\(\)/);
    expect(h["Strict-Transport-Security"]).toMatch(/^max-age=\d+/);
  });

  it("next.config applies them to every route and a no-content CSP to API routes", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.find((r) => r.source === "/:path*")?.headers).toEqual(STATIC_SECURITY_HEADERS);
    expect(rules.find((r) => r.source === "/api/:path*")?.headers).toEqual([{ key: "Content-Security-Policy", value: API_CSP }]);
  });
});
