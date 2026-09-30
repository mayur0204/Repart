import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Page not found | RePart" };

/** Any unknown address, or a record the viewer can't see (services throw NotFoundError, pages call notFound()). */
export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-6 px-4 py-8 lg:px-8">
      <h1 className="text-2xl lg:text-3xl">Page not found</h1>
      <EmptyState
        title="There's nothing at this address"
        body="The link may be mistyped, or the listing or order was removed or belongs to another account. Search for the part again, or go back to the home page."
        action={
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/search">Search parts</ButtonLink>
            <ButtonLink href="/" variant="secondary">Home</ButtonLink>
          </div>
        }
      />
    </main>
  );
}
