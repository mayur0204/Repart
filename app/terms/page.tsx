import type { Metadata } from "next";
import { Page } from "@/components/layout/page";
import { Badge } from "@/components/ui/display";

export const metadata: Metadata = { title: "Terms of use | RePart" };

/** Placeholder (REPART_BRIEF.md §9: static pages with placeholder text marked TODO). */
export default function TermsPage() {
  return (
    <Page title="Terms of use">
      <Badge tone="caution">TODO: text to be supplied before launch</Badge>
      <p className="prose-measure text-steel">This page is a placeholder. The final text will be added before RePart launches.</p>
    </Page>
  );
}
