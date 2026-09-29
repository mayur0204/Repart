"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { isActive, MOBILE_NAV } from "./nav";

/** Mobile bottom bar: Search, Garage, Sell (visually primary), Messages, Account. Hidden from lg up. */
export function BottomBar() {
  const pathname = usePathname() ?? "/";
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="grid grid-cols-5">
        {MOBILE_NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-sm",
                  item.primary ? "bg-action font-semibold text-surface" : active ? "font-semibold text-ink" : "text-steel",
                  !item.primary && active && "border-t-2 border-ink",
                )}
              >
                <Icon name={item.icon} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
