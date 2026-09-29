import { cn } from "@/lib/cn";
import { Icon, type IconName } from "@/components/ui/icon";

/** Mirrors FitResult from the server (kept structural so this file stays importable anywhere). */
export type Fit = { state: "FITS" | "SELLER_SAYS" | "MODIFICATION" | "NOT_FIT" | "NO_VEHICLE" | "UNKNOWN"; headline: string; detail: string | null };

const STYLE: Record<Fit["state"], { box: string; text: string; icon: IconName }> = {
  FITS: { box: "border-fit bg-fit-tint", text: "text-fit", icon: "check" },
  SELLER_SAYS: { box: "border-caution bg-caution-tint", text: "text-caution", icon: "alert" },
  MODIFICATION: { box: "border-caution bg-caution-tint", text: "text-caution", icon: "alert" },
  NOT_FIT: { box: "border-danger bg-danger-tint", text: "text-danger", icon: "error" },
  NO_VEHICLE: { box: "border-rule bg-page", text: "text-ink", icon: "bike" },
  UNKNOWN: { box: "border-rule bg-page", text: "text-ink", icon: "info" },
};

/** The signature fit status bar (brief §10): full width, boldest element on the listing page. Colour always paired with text and an icon. */
export function FitBar({ fit, children }: { fit: Fit; children?: React.ReactNode }) {
  const s = STYLE[fit.state];
  return (
    <section aria-label="Will this fit my bike?" className={cn("flex flex-col gap-2 border-2 p-4", s.box)}>
      <p className={cn("flex items-start gap-2 text-xl font-semibold [font-stretch:87.5%]", s.text)}>
        <Icon name={s.icon} size="lg" className="mt-0.5 shrink-0" />
        {fit.headline}
      </p>
      {fit.detail ? <p className={cn(fit.state === "MODIFICATION" ? "text-ink" : "text-steel")}>{fit.detail}</p> : null}
      {children}
    </section>
  );
}

/** One-line version for result tiles. */
export function FitLine({ fit }: { fit: Fit }) {
  const s = STYLE[fit.state];
  return (
    <p className={cn("flex items-start gap-1 text-sm font-semibold", fit.state === "NO_VEHICLE" || fit.state === "UNKNOWN" ? "text-steel" : s.text)}>
      <Icon name={s.icon} size="sm" className="mt-0.5 shrink-0" />
      <span>{fit.state === "FITS" && fit.detail ? `${fit.headline}. ${fit.detail}` : fit.headline}</span>
    </p>
  );
}
