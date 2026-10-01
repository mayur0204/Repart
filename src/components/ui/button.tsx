import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/**
 * Buttons (Stitch design system): primary = brand orange with navy text (white on #FF6B35 fails AA),
 * secondary = outline, tertiary = text with underline on hover. Minimum 44px tall, 8px corners. Labels are verbs.
 */
export type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-ink border border-brand hover:bg-brand-hover hover:border-brand-hover",
  secondary: "bg-surface text-ink border border-rule hover:border-ink hover:bg-page",
  tertiary: "bg-transparent text-action border border-transparent px-1 hover:underline underline-offset-4",
  danger: "bg-danger text-surface border border-danger hover:bg-ink hover:border-ink",
};

export function buttonClasses(variant: ButtonVariant = "primary", fullWidth = false): string {
  return cn(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-base font-semibold transition-colors duration-150",
    "disabled:cursor-not-allowed disabled:border-rule disabled:bg-page disabled:text-steel disabled:no-underline",
    VARIANTS[variant],
    fullWidth && "w-full",
  );
}

type ButtonProps = ComponentProps<"button"> & { variant?: ButtonVariant; fullWidth?: boolean };

export function Button({ variant = "primary", fullWidth, className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonClasses(variant, fullWidth), className)} {...props} />;
}

type ButtonLinkProps = ComponentProps<typeof Link> & { variant?: ButtonVariant; fullWidth?: boolean };

export function ButtonLink({ variant = "primary", fullWidth, className, ...props }: ButtonLinkProps) {
  return <Link className={cn(buttonClasses(variant, fullWidth), className)} {...props} />;
}
