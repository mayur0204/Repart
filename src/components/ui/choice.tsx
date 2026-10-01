"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Selection tiles and segmented controls (Stitch design system): used instead of radio circles and checkbox ticks.
 * Both are real radio groups underneath, so keyboard (arrow keys) and screen readers work natively.
 */
export type ChoiceOption<V extends string> = { value: V; label: string; description?: ReactNode; disabled?: boolean };

type GroupProps<V extends string> = {
  legend: string;
  name?: string;
  options: ChoiceOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  hideLegend?: boolean;
};

/** Grid of square tiles, one choice. */
export function OptionTileGroup<V extends string>({ legend, name, options, value, onChange, hideLegend }: GroupProps<V>) {
  const autoName = useId();
  return (
    <fieldset>
      <legend className={cn("mb-2 text-sm font-semibold", hideLegend && "sr-only")}>{legend}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-h-11 cursor-pointer flex-col gap-1 rounded-lg border bg-surface p-4 transition-colors duration-150",
              "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-action",
              value === o.value ? "border-2 border-action bg-brand-tint" : "border-rule hover:border-ink",
              o.disabled && "cursor-not-allowed text-steel",
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name={name ?? autoName}
              value={o.value}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            <span className="font-semibold">{o.label}</span>
            {o.description ? <span className="text-sm text-steel">{o.description}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Joined segments, one choice. Yes/No checklist questions use two segments. */
export function SegmentedControl<V extends string>({ legend, name, options, value, onChange, hideLegend }: GroupProps<V>) {
  const autoName = useId();
  return (
    <fieldset>
      <legend className={cn("mb-2 text-sm font-semibold", hideLegend && "sr-only")}>{legend}</legend>
      <div className="inline-flex rounded-full border border-rule bg-page p-1">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-h-10 min-w-16 cursor-pointer items-center justify-center rounded-full px-4 font-semibold transition-colors duration-150",
              "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-action",
              value === o.value ? "bg-ink text-surface" : "text-ink hover:bg-surface",
              o.disabled && "cursor-not-allowed text-steel",
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name={name ?? autoName}
              value={o.value}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
