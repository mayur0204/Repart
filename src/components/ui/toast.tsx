"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "./icon";

/** Toasts confirm what just happened ("Part listed"). Announced through a polite live region. */
export type ToastTone = "neutral" | "success" | "error";
type ToastItem = { id: number; message: string; tone: ToastTone };

const TONE: Record<ToastTone, { icon: IconName; className: string }> = {
  neutral: { icon: "info", className: "border-ink" },
  success: { icon: "check", className: "border-fit" },
  error: { icon: "error", className: "border-danger" },
};

const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});

export const useToast = () => useContext(ToastContext);

const DURATION_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (message: string, tone: ToastTone = "neutral") => {
      const id = Date.now() + Math.random();
      setItems((all) => [...all.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), DURATION_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed inset-x-4 bottom-20 z-50 flex flex-col items-center gap-2 lg:bottom-6"
      >
        {items.map((t) => (
          <div
            key={t.id}
            data-layer="floating"
            className={cn(
              "pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-lg border border-l-4 bg-surface p-3 text-ink shadow-float",
              TONE[t.tone].className,
            )}
          >
            <Icon name={TONE[t.tone].icon} />
            <p className="flex-1">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-m-2 flex size-11 items-center justify-center text-steel hover:text-ink"
            >
              <Icon name="close" size="sm" label="Dismiss" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
