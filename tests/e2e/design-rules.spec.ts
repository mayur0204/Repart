import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations, signInAs, USERS, type Role } from "./support/fixtures";

/**
 * Screenshot matrix (PLAN.md §8.3) with the rendered design-rule check (§8.2 layer 3) and axe on every screen.
 * Saved to screenshots/<milestone>/<route>-<state>-<width>.png (git-ignored). Only states a screen can really be in:
 * loaded, empty (a signed-in user with nothing there, or a search with no results), error (unknown record),
 * permission-denied (wrong role) and offline (context.setOffline, served by the service worker).
 */
const MILESTONE = process.env.SCREENSHOT_MILESTONE ?? "m13";
type State = "loaded" | "empty" | "error" | "permission-denied" | "offline";
type Shot = { route: string; path: string; state: State; as?: Role };

const SCREENS: Shot[] = [
  { route: "home", path: "/", state: "loaded" },
  { route: "search", path: "/search?q=mirror", state: "loaded" },
  { route: "search", path: "/search?q=no-such-part-zzz", state: "empty" },
  { route: "listing", path: "/listings/sample-listing-live-tier-a", state: "loaded" },
  { route: "listing", path: "/listings/no-such-listing", state: "error" },
  { route: "part-number", path: "/parts/sample-motors/SAMPLE-MIR-0001", state: "loaded" },
  { route: "how-it-works", path: "/how-it-works", state: "loaded" },
  { route: "sign-in", path: "/sign-in", state: "loaded" },
  { route: "checkout", path: "/checkout/sample-listing-live-tier-b-optional", state: "loaded", as: "buyer" },
  { route: "orders", path: "/orders", state: "loaded", as: "buyer" },
  { route: "orders", path: "/orders", state: "empty", as: "buyer2" },
  { route: "order", path: "/orders/sample-order-disputed", state: "loaded", as: "buyer" },
  { route: "order", path: "/orders/sample-order-completed", state: "error", as: "buyer2" },
  { route: "messages", path: "/messages", state: "loaded", as: "buyer" },
  { route: "messages", path: "/messages", state: "empty", as: "buyer2" },
  { route: "account", path: "/account", state: "loaded", as: "buyer" },
  { route: "garage", path: "/garage", state: "loaded", as: "buyer" },
  { route: "saved", path: "/account/saved", state: "empty", as: "buyer2" },
  { route: "sell", path: "/sell", state: "loaded", as: "seller" },
  { route: "seller", path: "/seller", state: "loaded", as: "seller" },
  { route: "seller-orders", path: "/seller/orders", state: "loaded", as: "seller" },
  { route: "seller-order", path: "/seller/orders/sample-order-awaiting-seller", state: "loaded", as: "seller" },
  { route: "mechanic", path: "/mechanic", state: "loaded", as: "mechanic" },
  { route: "mechanic", path: "/mechanic", state: "permission-denied", as: "buyer" },
  { route: "admin", path: "/admin", state: "loaded", as: "admin" },
  { route: "admin", path: "/admin", state: "permission-denied", as: "buyer" },
  { route: "admin-orders", path: "/admin/orders", state: "loaded", as: "admin" },
  { route: "admin-disputes", path: "/admin/disputes", state: "loaded", as: "admin" },
  { route: "admin-reports", path: "/admin/reports", state: "empty", as: "admin" },
  { route: "admin-users", path: "/admin/users", state: "loaded", as: "admin" },
  { route: "admin-agreement", path: "/admin/agreement", state: "loaded", as: "admin" },
  { route: "admin-export", path: "/admin/export", state: "loaded", as: "admin" },
  { route: "admin-audit", path: "/admin/audit", state: "loaded", as: "admin" },
  { route: "admin-audit", path: "/admin/audit?actor=nobody", state: "empty", as: "admin" },
  { route: "listing", path: "/listings/sample-listing-live-tier-a", state: "offline" },
  { route: "orders", path: "/orders", state: "offline", as: "buyer" },
];

async function renderedDesignProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const s = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const radii = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius];
      // Stitch shapes only: 4px checkbox, 8px controls, 16px cards, 9999px pills.
      if (radii.some((r) => !/^(0|4|8|16|9999)px$/.test(r))) out.push(`radius on <${tag}>`);
      if (s.boxShadow !== "none" && el.dataset.layer !== "floating") out.push(`shadow on <${tag}>`);
      if (/gradient/.test(s.backgroundImage)) out.push(`gradient on <${tag}>`);
      if (s.textTransform === "uppercase") out.push(`uppercase on <${tag}>`);
      if (/monospace/.test(s.fontFamily)) out.push(`monospace on <${tag}>`);
    }
    if (/\S\s·\s\S/.test(document.body.innerText)) out.push("middle-dot meta string");
    return out;
  });
}

for (const shot of SCREENS) {
  test(`${shot.route} ${shot.state}${shot.as ? ` (${shot.as})` : ""}`, async ({ page, context }, info) => {
    if (shot.as) await signInAs(context, USERS[shot.as]);

    if (shot.state === "offline") {
      await page.goto(shot.path);
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload(); // the service worker now controls the page and has seen it once
      await page.waitForLoadState("networkidle");
      await context.setOffline(true);
      await page.reload();
      // A public page comes from the last-viewed cache; a private one falls back to the offline page.
      await expect(page.getByRole("status").filter({ hasText: "You're offline" }).or(page.getByRole("heading", { name: "You're offline" })).first()).toBeVisible();
    } else {
      const res = await page.goto(shot.path);
      if (shot.state === "error") expect(res?.status()).toBe(404);
      if (shot.state === "error") await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
      if (shot.state === "permission-denied") await expect(page.getByText("You don't have access to this page")).toBeVisible();
      if (shot.state === "empty") await expect(page.locator("main section h2").first()).toBeVisible();
      await page.waitForLoadState("networkidle");
    }

    expect(await renderedDesignProblems(page)).toEqual([]);
    await expectNoAxeViolations(page);

    const width = info.project.use.viewport?.width ?? 0;
    mkdirSync(`screenshots/${MILESTONE}`, { recursive: true });
    await page.screenshot({ path: `screenshots/${MILESTONE}/${shot.route}-${shot.state}-${width}.png`, fullPage: true });
    if (shot.state === "offline") await context.setOffline(false);
  });
}
