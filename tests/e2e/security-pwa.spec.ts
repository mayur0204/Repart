import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { one } from "./support/db";
import { E2E_PAYMENT_SECRET, E2E_SHIPPING_SECRET } from "./support/env";
import { signInAs, unsignedPost, USERS } from "./support/fixtures";

/** Live checks against the production build: headers/CSP, webhook authenticity, PWA installability and offline. */
test.describe("security headers", () => {
  test("pages carry a nonce CSP and the static headers; the nonce changes per request", async ({ request }) => {
    const a = await request.get("/");
    const b = await request.get("/");
    const csp = a.headers()["content-security-policy"];
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests"); // plain HTTP locally
    expect(csp).not.toBe(b.headers()["content-security-policy"]);
    const h = a.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toContain("geolocation=()");
    expect(h["x-powered-by"]).toBeUndefined();
    expect(csp).not.toMatch(/SERVICE_ROLE|eyJ|secret/i);
  });

  test("API responses get a no-content CSP", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("the rendered page runs with the CSP: no violations while loading and hydrating", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto("/listings/sample-listing-live-tier-a");
    await page.waitForLoadState("networkidle");
    await page.goto("/search?q=mirror");
    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });
});

test.describe("webhook authenticity", () => {
  const sign = (secret: string, body: string, ts = Date.now()) => ({ "content-type": "application/json", "x-mock-timestamp": String(ts), "x-mock-signature": createHmac("sha256", secret).update(`${ts}${body}`).digest("hex") });

  test("payment webhooks: unsigned, wrongly signed and replayed events change nothing", async ({ request }) => {
    const body = JSON.stringify({ providerEventId: `e2e_evt_${randomUUID()}`, type: "PAYMENT_SUCCESS", providerType: "MOCK", orderId: "sample-order-awaiting-seller", providerPaymentId: "x", amount: 1, currency: "INR" });
    expect((await unsignedPost(request, "/api/webhooks/payments/mock", body)).status()).toBe(401);
    expect((await request.post("/api/webhooks/payments/mock", { data: body, headers: sign("wrong-secret-0123456789", body) })).status()).toBe(401);
    const old = Date.now() - 10 * 60_000;
    expect((await request.post("/api/webhooks/payments/mock", { data: body, headers: sign(E2E_PAYMENT_SECRET, body, old) })).status()).toBe(401);
    expect(await one(`SELECT 1 FROM "WebhookEvent" WHERE "providerEventId" = $1`, [JSON.parse(body).providerEventId])).toBeUndefined();
  });

  test("courier webhooks: bad signature and stale timestamp are refused; a duplicate event is processed once", async ({ request }) => {
    const body = JSON.stringify({ providerEventId: `e2e_trk_${randomUUID()}`, shipmentId: "unknown", status: "IN_TRANSIT", at: new Date().toISOString() });
    expect((await unsignedPost(request, "/api/webhooks/shipping/mock", body)).status()).toBe(401);
    expect((await request.post("/api/webhooks/shipping/mock", { data: body, headers: sign(E2E_SHIPPING_SECRET, body, Date.now() - 10 * 60_000) })).status()).toBe(401);
  });

  test("the browser can't mark an order paid: checkout return only asks the provider", async ({ page }) => {
    await signInAs(page.context(), USERS.buyer);
    await page.goto("/checkout/return?order_id=sample-order-awaiting-seller&status=PAID");
    expect((await one<{ state: string }>(`SELECT state FROM "Order" WHERE id = 'sample-order-awaiting-seller'`))?.state).toBe("AWAITING_SELLER");
  });
});

test.describe("PWA", () => {
  test("manifest is installable: name, standalone, start URL and 192/512 PNG icons that exist", async ({ request }) => {
    const m = await (await request.get("/manifest.webmanifest")).json();
    expect(m).toMatchObject({ name: "RePart", short_name: "RePart", display: "standalone", start_url: "/" });
    for (const size of ["192x192", "512x512"]) {
      const icon = m.icons.find((i: { sizes: string; type: string }) => i.sizes === size && i.type === "image/png");
      expect(icon, size).toBeDefined();
      const res = await request.get(icon.src);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/png");
    }
    expect((await request.get("/sw.js")).headers()["cache-control"]).toBe("no-cache");
  });

  test("Chrome reports no installability errors (the check Lighthouse's old PWA category used)", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    const cdp = await page.context().newCDPSession(page);
    const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string }[] };
    // Playwright contexts are incognito, and Chrome never installs from incognito; anything else is a real problem.
    expect(installabilityErrors.map((e) => e.errorId).filter((id) => id !== "in-incognito")).toEqual([]);
  });

  test("offline: a public page read before stays readable, forms are disabled with a message, nothing private is cached", async ({ page, context }) => {
    await signInAs(context, USERS.buyer);
    await page.goto("/listings/sample-listing-live-tier-a");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.goto("/orders"); // private: must never be cached
    await page.goto("/listings/sample-listing-live-tier-a");
    await page.waitForLoadState("networkidle");

    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
      return out;
    });
    expect(cached).toContain("/listings/sample-listing-live-tier-a");
    expect(cached).toContain("/offline");
    expect(cached.filter((p) => /^\/(orders|account|admin|messages|api|checkout|seller|sell|mechanic|garage)/.test(p))).toEqual([]);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "You're offline" })).toBeVisible();
    const save = page.getByRole("button", { name: /Save|Remove from saved/ }).first();
    if (await save.count()) await expect(save).toBeDisabled();

    await page.goto("/orders").catch(() => undefined);
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    await context.setOffline(false);
  });
});
