import type { Metadata } from "next";
import { Page } from "@/components/layout/page";
import { TRUST_TEXT } from "@/components/listing/trust";

export const metadata: Metadata = { title: "How RePart works | RePart" };

export default function HowItWorksPage() {
  return (
    <Page title="How RePart works">
      <section className="prose-measure flex flex-col gap-3">
        <h2 className="text-xl">Checking fit</h2>
        <p>We keep a catalogue of which part numbers fit which bikes, and which numbers are the same part or replace each other. Add your bike and every listing tells you whether it fits, and how we know.</p>
        <h2 className="text-xl">Checking listings</h2>
        <p>Every listing is checked before it goes live: the photos, the details and the part number. Listings that need changes go back to the seller with what to fix.</p>
        <h2 className="text-xl">Trust labels</h2>
        {Object.values(TRUST_TEXT).map((t) => (
          <p key={t.label}>
            <span className="font-semibold">{t.label}:</span> {t.sentence}
          </p>
        ))}
        <h2 className="text-xl">Paying and delivery</h2>
        <p>You pay RePart, not the seller. The seller is paid after you confirm the part arrived as described.</p>
      </section>
    </Page>
  );
}
