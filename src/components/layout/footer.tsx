import Link from "next/link";
import { Logo } from "./logo";

const COLUMNS = [
  { title: "Buy", links: [{ href: "/search", label: "Search parts" }, { href: "/garage", label: "My garage" }, { href: "/orders", label: "Orders" }] },
  { title: "Sell", links: [{ href: "/sell", label: "Sell a part" }, { href: "/seller", label: "Seller dashboard" }] },
  { title: "Help", links: [{ href: "/how-it-works", label: "How RePart works" }, { href: "/help", label: "Help" }, { href: "/privacy", label: "Privacy" }, { href: "/terms", label: "Terms" }] },
];

/** Stitch footer, trimmed to routes that exist. */
export function Footer() {
  return (
    <footer className="mt-12 border-t border-rule bg-surface">
      <div className="mx-auto grid max-w-(--container-page) gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4 lg:px-8">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="max-w-xs text-sm text-steel">Used motorcycle and scooter parts from people who ride, checked before they ship.</p>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title} className="flex flex-col gap-2">
            <h2 className="text-base">{c.title}</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-steel hover:text-ink hover:underline underline-offset-4">{l.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
    </footer>
  );
}
