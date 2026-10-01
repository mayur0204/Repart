import { cn } from "@/lib/cn";
import { Icon, type IconName } from "@/components/ui/icon";

/** Mirrors FitResult from the server (kept structural so this file stays importable anywhere). */
export type Fit = { state: "FITS" | "SELLER_SAYS" | "MODIFICATION" | "NOT_FIT" | "NO_VEHICLE" | "UNKNOWN"; headline: string; detail: string | null };

const STYLE: Record<Fit["state"], { box: string; text: string; dot: string; icon: IconName }> = {
  FITS: { box: "border-fit bg-fit-tint", text: "text-fit", dot: "bg-fit text-surface", icon: "check" },
  SELLER_SAYS: { box: "border-caution bg-caution-tint", text: "text-caution", dot: "bg-caution text-surface", icon: "alert" },
  MODIFICATION: { box: "border-caution bg-caution-tint", text: "text-caution", dot: "bg-caution text-surface", icon: "alert" },
  NOT_FIT: { box: "border-danger bg-danger-tint", text: "text-danger", dot: "bg-danger text-surface", icon: "error" },
  NO_VEHICLE: { box: "border-rule bg-page", text: "text-ink", dot: "bg-ink text-surface", icon: "bike" },
  UNKNOWN: { box: "border-rule bg-page", text: "text-ink", dot: "bg-steel text-surface", icon: "info" },
};

/** The signature fit status bar (brief §10): full width, boldest element on the listing page. Colour always paired with text and an icon. */
export function FitBar({ fit, children }: { fit: Fit; children?: React.ReactNode }) {
  const s = STYLE[fit.state];
  return (
    <section aria-label="Will this fit my bike?" className={cn("flex flex-col gap-3 rounded-lg border-2 p-4", s.box)}>
      <div className="flex items-start gap-3">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", s.dot)}>
          <Icon name={s.icon} />
        </span>
        <div className="flex flex-col gap-0.5">
          <p className={cn("font-heading text-xl font-bold", s.text)}>{fit.headline}</p>
          {fit.detail ? <p className={cn(fit.state === "MODIFICATION" ? "text-ink" : "text-steel")}>{fit.detail}</p> : null}
        </div>
      </div>
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
