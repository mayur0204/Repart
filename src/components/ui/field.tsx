import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";

/**
 * Inputs (REPART_BRIEF.md §10): 1px rule border, 44px tall, label above, help text below,
 * error under the field in danger colour saying how to fix it.
 */
type FieldChrome = { label: string; help?: ReactNode; error?: string };

const controlClasses = (error?: string) =>
  cn(
    "block min-h-11 w-full border bg-surface px-3 text-base text-ink",
    "focus-visible:border-action disabled:bg-page disabled:text-steel",
    error ? "border-danger" : "border-rule",
  );

function FieldFrame({ id, label, help, error, children }: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {help && !error ? (
        <p id={`${id}-help`} className="text-sm text-steel">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1 text-sm text-danger">
          <Icon name="error" size="sm" className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

const describedBy = (id: string, help?: ReactNode, error?: string) =>
  error ? `${id}-error` : help ? `${id}-help` : undefined;

export function Input({ label, help, error, id, className, ...props }: FieldChrome & ComponentProps<"input">) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} help={help} error={error}>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        className={cn(controlClasses(error), className)}
        {...props}
      />
    </FieldFrame>
  );
}

export function Select({
  label,
  help,
  error,
  id,
  className,
  children,
  ...props
}: FieldChrome & ComponentProps<"select">) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} help={help} error={error}>
      <div className="relative">
        <select
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, help, error)}
          className={cn(controlClasses(error), "pr-10", className)}
          {...props}
        >
          {children}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-steel"
        >
          <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.75" />
        </svg>
      </div>
    </FieldFrame>
  );
}
