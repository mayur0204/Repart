"use client";

import Link from "next/link";
import "./globals.css";

/** Last resort when the root layout itself fails: no top bar, just what happened and how to recover. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-IN">
      <body className="min-h-dvh bg-page text-ink">
        <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-12">
          <h1 className="text-2xl">RePart didn&apos;t load</h1>
          <p>Something went wrong on our side. Nothing you saved is lost. Try again, or come back in a few minutes.</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={reset} className="min-h-11 border border-action bg-action px-4 font-semibold text-surface">
              Try again
            </button>
            <Link href="/" className="inline-flex min-h-11 items-center border border-ink px-4 font-semibold">
              Home
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
