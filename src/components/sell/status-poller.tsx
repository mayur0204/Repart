"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While a listing is being checked, polls check-status every 3 s and refreshes the page when the status changes. */
export function StatusPoller({ listingId, status }: { listingId: string; status: string }) {
  const router = useRouter();
  useEffect(() => {
    if (status !== "SUBMITTED" && status !== "SCREENING") return;
    let delay = 3000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/listings/${listingId}/check-status`, { cache: "no-store" });
        if (res.ok && ((await res.json()) as { status: string }).status !== status) return router.refresh();
      } catch {
        delay = Math.min(delay * 2, 30_000); // back off while offline
      }
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
  }, [listingId, status, router]);
  return null;
}
