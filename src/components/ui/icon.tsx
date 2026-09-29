import {
  TriangleAlert,
  Bike,
  Check,
  CircleAlert,
  Info,
  Lock,
  MessageSquare,
  PackageOpen,
  Plus,
  Search,
  User,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * The only place lucide-react is imported (PLAN.md §8.1). One stroke weight, one size scale.
 * Add icons to this registry rather than importing lucide elsewhere.
 */
const ICONS = {
  alert: TriangleAlert,
  bike: Bike,
  check: Check,
  error: CircleAlert,
  info: Info,
  lock: Lock,
  messages: MessageSquare,
  empty: PackageOpen,
  plus: Plus,
  search: Search,
  user: User,
  offline: WifiOff,
  close: X,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

const SIZES = { sm: 16, md: 20, lg: 24 } as const;

export function Icon({ name, size = "md", label, className }: { name: IconName; size?: keyof typeof SIZES; label?: string; className?: string }) {
  const Component = ICONS[name];
  return (
    <Component
      size={SIZES[size]}
      strokeWidth={1.75}
      className={className}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}
