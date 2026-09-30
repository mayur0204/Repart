"use client";

import { Button, ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";

/**
 * Unexpected errors while rendering a page (REPART_BRIEF.md §9 "error" state). Says what happened and what to do; the
 * digest lets support find the server log entry without showing any detail of the error itself.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-6 px-4 py-8 lg:px-8">
      <h1 className="text-2xl lg:text-3xl">Something went wrong</h1>
      <ErrorState
        title="This page didn't load"
        body={
          <>
            Nothing you saved before this page is lost. Try again; if it keeps happening, go back to the home page and try later.
            {error.digest ? <span className="mt-2 block text-sm">Reference: {error.digest}</span> : null}
          </>
        }
        action={
          <div className="flex flex-wrap gap-3">
            <Button onClick={reset}>Try again</Button>
            <ButtonLink href="/" variant="secondary">Home</ButtonLink>
          </div>
        }
      />
    </main>
  );
}
