import type { IconName } from "@/components/ui/icon";

/** Global navigation (REPART_BRIEF.md §9). Routes arrive in later milestones. */
export type NavItem = { href: string; label: string; icon: IconName; primary?: boolean };

export const MOBILE_NAV: NavItem[] = [
  { href: "/search", label: "Search", icon: "search" },
  { href: "/garage", label: "Garage", icon: "bike" },
  { href: "/sell", label: "Sell", icon: "plus", primary: true },
  { href: "/messages", label: "Messages", icon: "messages" },
  { href: "/account", label: "Account", icon: "user" },
];

export const DESKTOP_NAV: NavItem[] = [
  { href: "/sell", label: "Sell a part", icon: "plus", primary: true },
  { href: "/orders", label: "Orders", icon: "orders" },
  { href: "/messages", label: "Messages", icon: "messages" },
  { href: "/account", label: "Account", icon: "user" },
];

export const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);
