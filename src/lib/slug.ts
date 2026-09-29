/** URL slug: lowercase ASCII letters and digits joined by single dashes. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Public URL of a part-number page: /parts/<brand-slug>/<display number>. */
export function partNumberPath(p: { brand: string; display: string }): string {
  return `/parts/${slugify(p.brand)}/${encodeURIComponent(p.display)}`;
}
