"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { FormAction } from "@/components/forms/action-form";

type Action = FormAction;
type CashfreeFactory = (opts: { mode: "sandbox" | "production" }) => { checkout(opts: { paymentSessionId: string; redirectTarget?: string }): Promise<unknown> };
declare global {
  interface Window {
    Cashfree?: CashfreeFactory;
  }
}

/** Cashfree's official browser checkout (Cashfree.js v3), loaded only when a buyer pays. */
const CASHFREE_SDK = "https://sdk.cashfree.com/js/v3/cashfree.js";

function loadCashfree(): Promise<CashfreeFactory> {
  return new Promise((resolve, reject) => {
    if (window.Cashfree) return resolve(window.Cashfree);
    const script = document.createElement("script");
    script.src = CASHFREE_SDK;
    script.async = true;
    script.onload = () => (window.Cashfree ? resolve(window.Cashfree) : reject(new Error("The payment page didn't load.")));
    script.onerror = () => reject(new Error("The payment page didn't load. Check your connection and try again."));
    document.head.appendChild(script);
  });
}

/**
 * Submits a server action that returns a payment session, then opens the provider's checkout:
 * the Cashfree page for a payment_session_id, or the mock checkout URL in development.
 */
export function PayForm({ action, label, mode, children }: { action: Action; label: string; mode: "sandbox"; children?: ReactNode }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await action(null, formData);
      if (!result?.ok) return setError(result?.message ?? "That didn't work. Try again.");
      const data = (result.data ?? {}) as { paymentSessionId?: string | null; checkoutUrl?: string | null };
      try {
        if (data.checkoutUrl) window.location.assign(data.checkoutUrl);
        else if (data.paymentSessionId) await (await loadCashfree())({ mode }).checkout({ paymentSessionId: data.paymentSessionId, redirectTarget: "_self" });
        else setError("The payment couldn't be started. Try again.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "The payment page didn't load.");
      }
    });
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      {children}
      {error ? (
        <p role="alert" className="flex items-start gap-2 border border-danger bg-danger-tint p-3 text-danger">
          <Icon name="error" className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
      <Button type="submit" fullWidth disabled={pending}>
        {pending ? "Opening payment" : label}
      </Button>
    </form>
  );
}
