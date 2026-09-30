import { expect, test } from "@playwright/test";
import { signInAs, USERS, type Role } from "./support/fixtures";

/**
 * HTTP status for record pages (M13 review): an existing record is 200, a missing one (or one the viewer may not
 * see, which must look the same) is a real 404, not a 200 with a not-found page. Record pages have no loading
 * boundary above them, so the check runs before anything is streamed; list pages keep their skeleton.
 */
const CASES: { as?: Role; ok: string; missing: string[] }[] = [
  { ok: "/listings/sample-listing-live-tier-a", missing: ["/listings/no-such-listing"] },
  { ok: "/parts/sample-motors/SAMPLE-MIR-0001", missing: ["/parts/sample-motors/SAMPLE-NOPE-0000"] },
  { ok: "/sellers/sample-user-seller", missing: ["/sellers/no-such-seller"] },
  { as: "buyer", ok: "/orders/sample-order-disputed", missing: ["/orders/no-such-order", "/orders/no-such-order/dispute"] },
  { as: "buyer2", ok: "/orders", missing: ["/orders/sample-order-completed"] }, // someone else's order
  { as: "seller", ok: "/seller/orders/sample-order-awaiting-seller", missing: ["/seller/orders/no-such-order"] },
  { as: "admin", ok: "/admin/orders/sample-order-disputed", missing: ["/admin/orders/no-such-order", "/admin/users/no-such-user", "/admin/disputes/no-such-dispute"] },
  { ok: "/", missing: ["/no-such-page"] },
];

for (const c of CASES) {
  test(`${c.as ?? "visitor"}: ${c.ok} is 200; ${c.missing.join(", ")} ${c.missing.length > 1 ? "are" : "is"} 404`, async ({ page }) => {
    if (c.as) await signInAs(page.context(), USERS[c.as]);
    const ok = await page.goto(c.ok);
    expect(ok?.status(), c.ok).toBe(200);
    await expect(page.getByRole("heading", { name: "Page not found" })).toHaveCount(0);
    for (const path of c.missing) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    }
  });
}

test("list pages still stream their loading skeleton before the content", async ({ request }) => {
  const res = await request.get("/search?q=mirror");
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('aria-busy="true"'); // the skeleton is in the first part of the stream
  expect(html).toContain("SAMPLE right mirror"); // and the content follows in the same response
});
