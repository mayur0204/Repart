"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/** Admin section tabs: one horizontal pill row; the longest matching href is the current page. */
export function AdminNav({ items }: { items: Array<{ href: string; label: string }> }) {
  const pathname = usePathname() ?? "";
  const current = items
    .filter((n) => pathname === n.href || pathname.startsWith(`${n.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav aria-label="Admin" className="border-b border-rule bg-surface">
      <ul className="mx-auto flex max-w-(--container-page) gap-1 overflow-x-auto px-4 py-2 lg:flex-wrap lg:px-8">
        {items.map((n) => (
          <li key={n.href} className="shrink-0">
            <Link
              href={n.href}
              aria-current={n.href === current ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold transition-colors duration-150",
                n.href === current ? "bg-ink text-surface" : "text-ink hover:bg-page",
              )}
            >
              {n.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
