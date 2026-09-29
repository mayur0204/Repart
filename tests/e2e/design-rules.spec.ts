import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Rendered design-rule check (PLAN.md §8.2 layer 3) + axe, run on every screenshotted screen.
 * M1 has only the placeholder home page; later milestones add routes to SCREENS.
 */
const SCREENS = [{ name: "home", path: "/" }];

for (const screen of SCREENS) {
  test(`${screen.name}: rendered design rules, accessibility, screenshot`, async ({ page }, info) => {
    await page.goto(screen.path);

    const problems = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const s = getComputedStyle(el);
        const radii = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius];
        if (radii.some((r) => r !== "0px")) out.push(`radius on <${el.tagName.toLowerCase()}>`);
        if (s.boxShadow !== "none" && el.dataset.layer !== "floating") out.push(`shadow on <${el.tagName.toLowerCase()}>`);
        if (/gradient/.test(s.backgroundImage)) out.push(`gradient on <${el.tagName.toLowerCase()}>`);
        if (s.textTransform === "uppercase") out.push(`uppercase on <${el.tagName.toLowerCase()}>`);
        if (/monospace/.test(s.fontFamily)) out.push(`monospace on <${el.tagName.toLowerCase()}>`);
      }
      const text = document.body.innerText;
      if (/\S\s·\s\S/.test(text)) out.push("middle-dot meta string");
      return out;
    });
    expect(problems).toEqual([]);

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations).toEqual([]);

    await page.screenshot({ path: `screenshots/m1/${screen.name}-${info.project.name}.png`, fullPage: true });
  });
}
