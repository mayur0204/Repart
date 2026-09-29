import Link from "next/link";
import type { ReactNode } from "react";
import { ProgressBar } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { LISTING_STEPS, stepNumber, type StepSlug } from "@/lib/listing";

/** "Step X of 7" header with a progress bar and links to every step (brief §9). Steps are a real sequence, so numbering is allowed. */
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
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-6 px-4 py-8 lg:grid lg:grid-cols-12 lg:px-8">
      <nav aria-label="Listing steps" className="lg:col-span-3">
        <ol className="flex flex-col border border-rule bg-surface">
          {LISTING_STEPS.map((s, i) => {
            const open = i + 1 <= reached || i + 1 <= n;
            const done = open && !incomplete.includes(s.slug) && s.slug !== "review";
            const content = (
              <>
                <span className="num w-5 text-steel">{i + 1}</span>
                <span className="flex-1">{s.label}</span>
                {done ? <Icon name="check" size="sm" label="Complete" className="text-fit" /> : null}
              </>
            );
            return (
              <li key={s.slug} className="border-b border-rule last:border-b-0">
                {open ? (
                  <Link
                    href={`/sell/${listingId}/${s.slug}`}
                    aria-current={s.slug === step ? "step" : undefined}
                    className={cn("flex min-h-11 items-center gap-2 px-3", s.slug === step ? "bg-page font-semibold" : "text-action hover:bg-page")}
                  >
                    {content}
                  </Link>
                ) : (
                  <span className="flex min-h-11 items-center gap-2 px-3 text-steel">{content}</span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="flex flex-col gap-6 lg:col-span-9">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-steel">
            Step {n} of 7
          </p>
          <ProgressBar value={n} max={7} label={`Step ${n} of 7`} />
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
