import Link from "next/link";
import type { ReactNode } from "react";
import { ProgressBar } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { LISTING_STEPS, stepNumber, type StepSlug } from "@/lib/listing";

/**
 * Stitch "Sell a Part Wizard": a horizontal stepper card with a progress bar across the top, the step in a card below.
 * Links to every reached step (brief §9). Steps are a real sequence, so numbering is allowed.
 */
export function WizardFrame({
  listingId,
  step,
  reached,
  incomplete,
  children,
}: {
  listingId: string;
  step: StepSlug;
  reached: number;
  incomplete: StepSlug[];
  children: ReactNode;
}) {
  const n = stepNumber(step);
  const current = LISTING_STEPS[n - 1]!;
  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-6 px-4 py-8 lg:px-8">
      <nav aria-label="Listing steps" className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-3 lg:p-4">
        <ol className="flex gap-1 overflow-x-auto">
          {LISTING_STEPS.map((s, i) => {
            const open = i + 1 <= reached || i + 1 <= n;
            const done = open && !incomplete.includes(s.slug) && s.slug !== "review";
            const here = s.slug === step;
            const content = (
              <>
                <span
                  className={cn(
                    "num flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                    here ? "bg-brand text-ink" : done ? "bg-fit-tint text-fit" : "bg-page text-steel",
                  )}
                >
                  {done && !here ? <Icon name="check" size="sm" label="Complete" /> : i + 1}
                </span>
                <span className="whitespace-nowrap">{s.label}</span>
              </>
            );
            return (
              <li key={s.slug} className="flex-1">
                {open ? (
                  <Link
                    href={`/sell/${listingId}/${s.slug}`}
                    aria-current={here ? "step" : undefined}
                    className={cn("flex min-h-11 items-center gap-2 rounded-md px-2 text-sm", here ? "font-semibold text-ink" : "text-action hover:bg-page")}
                  >
                    {content}
                  </Link>
                ) : (
                  <span className="flex min-h-11 items-center gap-2 px-2 text-sm text-steel">{content}</span>
                )}
              </li>
            );
          })}
        </ol>
        <ProgressBar value={n} max={7} label={`Step ${n} of 7`} />
      </nav>
      <div className="flex flex-col gap-6 rounded-lg border border-rule bg-surface p-5 lg:p-8">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-action">Step {n} of 7</p>
          <h1 className="text-2xl lg:text-3xl">{current.label}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}


/** "Save draft" keeps the seller on the step; the main button saves and moves on. */
export function SaveDraftButton() {
  return (
    <button type="submit" name="intent" value="stay" className="inline-flex min-h-11 items-center px-1 text-action underline-offset-4 hover:underline">
      Save draft
    </button>
  );
}
