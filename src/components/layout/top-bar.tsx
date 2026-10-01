import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Logo } from "./logo";
import { DESKTOP_NAV } from "./nav";

/** Desktop: logo, search (bike or part number), Sell a part, Orders, Messages, Account. Mobile: logo only. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-surface">
      <div className="mx-auto flex min-h-16 max-w-(--container-page) items-center gap-6 px-4 lg:px-8">
        <Logo />
        <form action="/search" method="get" role="search" className="hidden flex-1 lg:flex">
          <label htmlFor="top-search" className="sr-only">
            Search by bike or part number
          </label>
          <input
            id="top-search"
            name="q"
            type="search"
            placeholder="Search by bike or part number"
            className="min-h-11 w-full max-w-xl rounded-l-md border border-r-0 border-rule bg-page px-4 focus-visible:border-action"
          />
          <button type="submit" className="inline-flex min-h-11 items-center rounded-r-md border border-rule bg-page px-3 text-steel hover:text-ink">
            <Icon name="search" label="Search" />
          </button>
        </form>
        <nav aria-label="Main" className="ml-auto hidden items-center gap-2 lg:flex">
          {DESKTOP_NAV.map((item) =>
            item.primary ? (
              <Link key={item.href} href={item.href} className={buttonClasses("primary")}>
                <Icon name={item.icon} size="sm" />
                {item.label}
              </Link>
            ) : (
              <Link key={item.href} href={item.href} className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 font-semibold text-ink hover:bg-page">
                <Icon name={item.icon} size="sm" className="text-steel" />
                {item.label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </header>
  );
}
