import {
  TriangleAlert,
  Bike,
  Check,
  ChevronRight,
  CircleAlert,
  Info,
  Lock,
  MapPin,
  MessageSquare,
  Package,
  PackageOpen,
  Plus,
  Search,
  ShieldCheck,
  Store,
  Truck,
  User,
  Wallet,
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
  chevron: ChevronRight,
  error: CircleAlert,
  info: Info,
  lock: Lock,
  location: MapPin,
  messages: MessageSquare,
  empty: PackageOpen,
  orders: Package,
  plus: Plus,
  search: Search,
  shield: ShieldCheck,
  store: Store,
  truck: Truck,
  user: User,
  wallet: Wallet,
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
