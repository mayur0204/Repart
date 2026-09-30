import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/server/auth/current";
import { disputes } from "@/server/services";

const NAV = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/catalogue", label: "Catalogue" },
  { href: "/admin/categories", label: "Categories" },
  { href: "/admin/catalogue/import", label: "CSV import" },
  { href: "/admin/interchange", label: "Interchange" },
  { href: "/admin/listings", label: "Listing review" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/disputes", label: "Disputes" },
  { href: "/admin/mechanics", label: "Mechanics" },
  { href: "/admin/reconciliation", label: "Reconciliation" },
  { href: "/admin/settings", label: "Settings" },
];

/**
 * Admin section frame. Access is checked by each page (adminPage) and each action (defineAction).
 * PLAN.md §5.3: a banner that can't be dismissed shows on every admin page while any dispute is within 24 hours of
 * the payment provider's automatic release.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  const critical = user?.roles.includes("ADMIN") ? (await disputes.nearAutoRelease()).criticalDisputes : 0;
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
      {critical ? (
        <p role="alert" className="border-b border-danger bg-danger-tint px-4 py-3 text-center font-semibold text-danger">
          {critical} {critical === 1 ? "dispute is" : "disputes are"} within 24 hours of the automatic payout release.{" "}
          <Link href="/admin" className="underline underline-offset-4">Resolve now</Link>
        </p>
      ) : null}
      {children}
    </div>
  );
}
