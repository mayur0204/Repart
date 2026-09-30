"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";

const subscribe = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/** True while the browser reports no connection. The server render assumes online. */
export function useOffline(): boolean {
  return useSyncExternalStore(subscribe, () => !navigator.onLine, () => false);
}

export const OFFLINE_MUTATION_MESSAGE = "You're offline, so nothing can be saved, bought or sent right now. Reconnect and try again.";

/**
 * PLAN.md §1.2 "PWA": mutations are disabled with a clear message when offline. There are no offline writes.
 * Forms built with ActionForm/InlineAction/PayForm also disable their buttons; this capture-phase guard catches every
 * other non-GET form so nothing is attempted and silently lost.
 */
export function OfflineBanner() {
  const offline = useOffline();
  useEffect(() => {
    if (!offline) return;
    const block = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement;
      // Only explicit GET forms (search, filters) are reads; a form without a method (e.g. the message box) is not.
      if (form.getAttribute("method")?.toLowerCase() === "get") return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("submit", block, true);
    return () => window.removeEventListener("submit", block, true);
  }, [offline]);

  if (!offline) return null;
  return (
    <p role="status" className="flex items-start gap-2 border-b border-caution bg-caution-tint px-4 py-3 text-caution lg:px-8">
      <Icon name="offline" className="mt-0.5 shrink-0" />
      {OFFLINE_MUTATION_MESSAGE} Pages you&apos;ve opened recently can still be read.
    </p>
  );
}
