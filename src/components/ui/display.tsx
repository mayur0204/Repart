import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatDate, formatPrice } from "@/lib/format";
import { Icon, type IconName } from "./icon";

/** Small presentational components. Status colour always comes with text and an icon. */

export type Tone = "neutral" | "fit" | "caution" | "danger";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-page text-ink border-rule",
  fit: "bg-fit-tint text-fit border-fit-tint",
  caution: "bg-caution-tint text-caution border-caution-tint",
  danger: "bg-danger-tint text-danger border-danger-tint",
};
const TONE_ICON: Record<Tone, IconName> = { neutral: "info", fit: "check", caution: "alert", danger: "error" };

export function Badge({ tone = "neutral", icon, children }: { tone?: Tone; icon?: IconName | false; children: ReactNode }) {
  const iconName = icon === false ? null : (icon ?? TONE_ICON[tone]);
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm font-semibold", TONE_CLASSES[tone])}>
      {iconName ? <Icon name={iconName} size="sm" /> : null}
      {children}
    </span>
  );
}

const PRICE_SIZES = { sm: "text-base", md: "text-xl", lg: "text-4xl" } as const;

export function Price({ paise, size = "md", className }: { paise: number; size?: keyof typeof PRICE_SIZES; className?: string }) {
  return <span className={cn("num font-heading font-extrabold", PRICE_SIZES[size], className)}>{formatPrice(paise)}</span>;
}

/** Part numbers: tabular, slightly larger, semibold, letter-spaced; never monospace. */
export function PartNumberText({ value, className }: { value: string; className?: string }) {
  return <span className={cn("part-no", className)}>{value}</span>;
}

export function DateText({ date, className }: { date: Date | string; className?: string }) {
  const d = typeof date === "string" ? new Date(date) : date;
  return (
    <time dateTime={d.toISOString()} className={className}>
      {formatDate(d)}
    </time>
  );
}

/** Loading placeholder shaped like the final content (no spinners). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-rule", className)} />;
}

export function ProgressBar({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-2 w-full overflow-hidden rounded-full bg-rule"
    >
      <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Keyboard- and hover-reachable explanation. Content is also the accessible description of the trigger. */
export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <span tabIndex={0} aria-describedby={id} className="inline-flex cursor-help">
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        data-layer="floating"
        className={cn(
          "invisible absolute bottom-full left-0 z-40 mb-2 w-max max-w-64 rounded-md border border-ink bg-ink px-2 py-1 text-sm text-surface shadow-float",
          "group-focus-within:visible group-hover:visible",
        )}
      >
        {content}
      </span>
    </span>
  );
}
