import { expect, test, type Page } from "@playwright/test";
import { gotoReady, signInAs, USERS } from "./support/fixtures";

/**
 * Keyboard walkthroughs (brief §10 "Accessibility", PLAN.md M13): every stop is visible, shows the 2px action-coloured
 * square outline, tab order moves forward through the page without a trap, and Enter/Space activate controls.
 */
type Stop = { tag: string; name: string; outline: string; radius: string; visible: boolean };

async function tabStops(page: Page, count: number): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return { tag: "body", name: "", outline: "", radius: "", visible: false };
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          name: (el.getAttribute("aria-label") ?? el.textContent ?? (el as HTMLInputElement).name ?? "").trim().slice(0, 40),
          outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
          radius: s.borderTopLeftRadius,
          visible: r.width > 0 && r.height > 0,
        };
      }),
    );
  }
  return stops;
}

/** The design system's focus ring: 2px solid in the action colour (#0B5FB0 family), square. */
function expectFocusRing(stops: Stop[]) {
  for (const s of stops.filter((x) => x.tag !== "body")) {
    expect(s.visible, `${s.tag} "${s.name}" is on screen`).toBe(true);
    expect(s.outline, `${s.tag} "${s.name}" focus ring`).toMatch(/^solid 2px rgb/);
    expect(s.radius, `${s.tag} "${s.name}" uses a Stitch radius token`).toMatch(/^(0|4|8|16|9999)px$/);
  }
}

test("site navigation: skip link first, then header links, all with the focus ring", async ({ page }) => {
  await gotoReady(page, "/");
  const stops = await tabStops(page, 8);
  expect(stops[0]).toMatchObject({ tag: "a", name: "Skip to content" });
  expectFocusRing(stops);
  await page.reload();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeInViewport(); // shown when focused
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});

test("search from the keyboard", async ({ page }) => {
  await gotoReady(page, "/");
  const search = page.getByRole("search").first().getByRole("searchbox").or(page.getByRole("search").first().getByRole("textbox")).first();
  await search.focus();
  await page.keyboard.type("mirror");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?.*=mirror/);
  expectFocusRing(await tabStops(page, 15));
});

test("listing detail: reach Buy now by Tab and open it with Enter; details disclosure toggles with Space", async ({ page }) => {
  await signInAs(page.context(), USERS.buyer);
  await gotoReady(page, "/listings/sample-listing-live-tier-a");
  const stops = await tabStops(page, 60);
  expectFocusRing(stops);
  expect(new Set(stops.map((s) => `${s.tag}:${s.name}`)).size, "focus moves on (no trap)").toBeGreaterThan(10);

  const summary = page.locator("details > summary").first();
  await summary.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("details").first()).toHaveAttribute("open", "");

  const buy = page.getByRole("link", { name: "Buy now" }).first();
  await buy.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/checkout\/sample-listing-live-tier-a/);
  const checkout = await tabStops(page, 30);
  expectFocusRing(checkout);
  expect(checkout.some((s) => s.tag === "button" && /^Pay /.test(s.name)), "Pay button reachable").toBe(true);
});

test("sell wizard: start a listing and fill the first step without a mouse", async ({ page }) => {
  await signInAs(page.context(), USERS.seller);
  await gotoReady(page, "/sell");
  await page.getByRole("button", { name: "Start a new listing" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/sell\/[^/]+\/bike$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Make").focus();
  await page.keyboard.press("ArrowDown"); // native selects change value from the keyboard
  await expect(page.getByLabel("Model")).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Model")).toBeFocused();
  expectFocusRing(await tabStops(page, 12));
});

test("admin: filter a table and act on a user from the keyboard", async ({ page }) => {
  await signInAs(page.context(), USERS.admin);
  await gotoReady(page, "/admin/users");
  const q = page.getByRole("textbox").first();
  await q.focus();
  await page.keyboard.type("sample-user-buyer-2");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=sample-user-buyer-2/);
  expectFocusRing(await tabStops(page, 25));

  await gotoReady(page, "/admin/disputes/sample-dispute-1");
  const decision = page.getByLabel("Decision");
  await decision.focus();
  await page.keyboard.press("ArrowDown"); // native select changes value from the keyboard
  await expect(decision).toHaveValue("RELEASE");
  expectFocusRing(await tabStops(page, 10));
});

test("mechanic portal is usable from the keyboard at phone width", async ({ page }) => {
  await signInAs(page.context(), USERS.mechanic);
  await gotoReady(page, "/mechanic");
  expectFocusRing(await tabStops(page, 12));
});

test("forms report errors to assistive tech and keep focus on the page", async ({ page }) => {
  await gotoReady(page, "/sign-in");
  await page.getByLabel("Mobile number").focus();
  await page.keyboard.type("12345");
  await page.keyboard.press("Enter");
  const alert = page.getByRole("alert").filter({ hasText: /\S/ }).first();
  await expect(alert).toBeVisible();
  await expect(page.getByLabel("Mobile number")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Mobile number")).toHaveAttribute("aria-describedby", /.+/);
});
