import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge, DateText, PartNumberText, Price, ProgressBar, Skeleton, Tooltip } from "@/components/ui/display";
import { Input, Select } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { EmptyState, ErrorState, OfflineState, PermissionDenied } from "@/components/ui/states";
import { ChoiceDemo, OverlayDemo } from "./interactive";

export const metadata: Metadata = { title: "Components | RePart dev", robots: { index: false } };

/** Development-only gallery of base components (PLAN.md §9 M1). 404 in production. */
export default function ComponentsGallery() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-10 px-4 py-8 lg:px-8">
      <h1 className="text-3xl">Components</h1>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button>List part</Button>
          <Button variant="secondary">Save draft</Button>
          <Button variant="tertiary">Edit address</Button>
          <Button variant="danger">Cancel order</Button>
          <Button disabled>Buy now</Button>
        </div>
      </Section>

      <Section title="Inputs">
        <div className="grid max-w-xl gap-4">
          <Input label="Pincode" inputMode="numeric" help="We use this to work out delivery cost." placeholder="560001" />
          <Input label="Asking price" defaultValue="12" error="Enter a price of at least ₹50." />
          <Select label="Category" defaultValue="">
            <option value="" disabled>
              Choose a category
            </option>
            <option>Brake parts</option>
            <option>Body panels</option>
          </Select>
        </div>
      </Section>

      <Section title="Option tiles and segmented control">
        <div className="max-w-xl">
          <ChoiceDemo />
        </div>
      </Section>

      <Section title="Dialog, sheet and toast">
        <OverlayDemo />
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge tone="fit">Matched by part number</Badge>
          <Badge tone="caution">Not confirmed</Badge>
          <Badge tone="danger">Does not fit</Badge>
          <Badge>Draft</Badge>
        </div>
      </Section>

      <Section title="Price, part number, date">
        <dl className="grid max-w-md grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2">
          <dt className="text-steel">Price</dt>
          <dd>
            <Price paise={12_500_000} size="lg" />
          </dd>
          <dt className="text-steel">Small price</dt>
          <dd>
            <Price paise={7_500_000} size="sm" />
          </dd>
          <dt className="text-steel">Part number</dt>
          <dd>
            <PartNumberText value="SAMPLE-BRK-00412" />
          </dd>
          <dt className="text-steel">Listed</dt>
          <dd>
            <DateText date="2026-09-28T10:00:00+05:30" />
          </dd>
        </dl>
      </Section>

      <Section title="Tooltip and icons">
        <div className="flex items-center gap-4">
          <Tooltip content="A RePart mechanic inspected this part before it was listed.">
            <Badge tone="fit">Partner checked</Badge>
          </Tooltip>
          <Icon name="search" />
          <Icon name="bike" />
          <Icon name="alert" />
        </div>
      </Section>

      <Section title="Loading">
        <div className="grid max-w-md gap-3">
          <ProgressBar value={3} max={7} label="Listing steps completed" />
          <Skeleton className="aspect-square w-40" />
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-40" />
        </div>
      </Section>

      <Section title="Screen states">
        <div className="grid gap-4 lg:grid-cols-2">
          <EmptyState title="No saved parts yet" body="Save a listing to find it here later. Start by searching for your bike." action={<Button variant="secondary">Search parts</Button>} />
          <ErrorState title="We couldn't load your orders" body="The server didn't respond. Reload the page to try again." action={<Button variant="secondary">Reload</Button>} />
          <OfflineState title="You're offline" body="Check your connection, then reload." />
          <PermissionDenied />
        </div>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-rule pt-6">
      <h2 className="text-xl">{title}</h2>
      {children}
    </section>
  );
}
