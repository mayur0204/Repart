import Link from "next/link";
import type { ReactNode } from "react";

type Params = Record<string, string | string[] | undefined>;

/** Flattens Next.js search params into plain strings (first value wins). */
export function plainParams(sp: Params): Record<string, string> {
  return Object.fromEntries(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : Array.isArray(v) && v[0] ? [[k, v[0]]] : [])));
}

/** A GET filter form: the URL is the state, so filtered lists can be bookmarked and shared between admins. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 border border-rule bg-surface p-3">
      {children}
      <button type="submit" className="min-h-11 border border-ink bg-surface px-4 font-semibold hover:bg-page">Apply</button>
    </form>
  );
}

/** Previous / next page links that keep the current filters. */
export function Pager({ path, params, page, pages, total }: { path: string; params: Record<string, string>; page: number; pages: number; total: number }) {
  const href = (p: number) => `${path}?${new URLSearchParams({ ...params, page: String(p) }).toString()}`;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-4 text-sm">
      <span className="text-steel">
        {total} {total === 1 ? "result" : "results"}, page {page} of {pages}
      </span>
      {page > 1 ? <Link href={href(page - 1)} className="text-action underline underline-offset-4">Previous</Link> : null}
      {page < pages ? <Link href={href(page + 1)} className="text-action underline underline-offset-4">Next</Link> : null}
    </nav>
  );
}
