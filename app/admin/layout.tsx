import Link from "next/link";
import type { ReactNode } from "react";

const NAV = [
  { href: "/admin/catalogue", label: "Catalogue" },
  { href: "/admin/categories", label: "Categories" },
  { href: "/admin/catalogue/import", label: "CSV import" },
  { href: "/admin/interchange", label: "Interchange" },
  { href: "/admin/listings", label: "Listing review" },
  { href: "/admin/settings", label: "Settings" },
];

/** Admin section frame. Access is checked by each page (adminPage) and each action (defineAction). */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <nav aria-label="Admin" className="border-b border-rule bg-surface">
        <ul className="mx-auto flex max-w-(--container-page) flex-wrap gap-x-6 px-4 lg:px-8">
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href} className="inline-flex min-h-11 items-center text-action underline-offset-4 hover:underline">
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </div>
  );
}
