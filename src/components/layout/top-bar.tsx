import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { DESKTOP_NAV } from "./nav";

/** Desktop: logo, search (bike or part number), Sell a part, Messages, Account. Mobile: logo only. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-surface">
      <div className="mx-auto flex min-h-14 max-w-(--container-page) items-center gap-6 px-4 lg:px-8">
        <Link href="/" className="text-xl font-semibold text-ink [font-stretch:87.5%]">
          RePart
        </Link>
        <form action="/search" method="get" role="search" className="hidden flex-1 lg:flex">
          <label htmlFor="top-search" className="sr-only">
            Search by bike or part number
          </label>
          <input
            id="top-search"
            name="q"
            type="search"
            placeholder="Search by bike or part number"
            className="min-h-11 w-full max-w-xl border border-r-0 border-rule bg-surface px-3 focus-visible:border-action"
          />
          <button type="submit" className={buttonClasses("secondary")}>
            <Icon name="search" label="Search" />
          </button>
        </form>
        <nav aria-label="Main" className="ml-auto hidden items-center gap-2 lg:flex">
          {DESKTOP_NAV.map((item) =>
            item.primary ? (
              <Link key={item.href} href={item.href} className={buttonClasses("primary")}>
                {item.label}
              </Link>
            ) : (
              <Link key={item.href} href={item.href} className={buttonClasses("tertiary")}>
                {item.label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </header>
  );
}
