import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Standard page frame: left-aligned, max 1280px, heading + optional intro. */
export function Page({
  title,
  intro,
  children,
  narrow,
  actions,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  narrow?: boolean;
  actions?: ReactNode;
}) {
  return (
    <main className={cn("mx-auto flex flex-col gap-6 px-4 py-8 lg:px-8", narrow ? "max-w-xl" : "max-w-(--container-page)")}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl lg:text-3xl">{title}</h1>
          {intro ? <div className="prose-measure text-steel">{intro}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </main>
  );
}
