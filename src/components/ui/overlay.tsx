"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";

/**
 * Dialog and Sheet on the native <dialog> element: focus trap, Escape to close and
 * inert background come from the browser. These are floating layers, so they carry the one allowed shadow.
 */
type OverlayProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
};

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handle = () => onClose();
    el.addEventListener("close", handle);
    return () => el.removeEventListener("close", handle);
  }, [onClose]);
  return ref;
}

function OverlayBody({ title, onClose, children, footer }: Omit<OverlayProps, "open">) {
  return (
    <>
      <div className="flex items-start justify-between gap-4 border-b border-rule p-4">
        <h2 className="text-xl">{title}</h2>
        <button type="button" onClick={onClose} className="-m-2 flex size-11 items-center justify-center text-steel hover:text-ink">
          <Icon name="close" label="Close" />
        </button>
      </div>
      <div className="p-4">{children}</div>
      {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-rule p-4">{footer}</div> : null}
    </>
  );
}

const backdrop = "backdrop:bg-ink/50";

export function Dialog(props: OverlayProps) {
  const ref = useDialog(props.open, props.onClose);
  return (
    <dialog
      ref={ref}
      data-layer="floating"
      aria-label={props.title}
      className={cn("m-auto w-[calc(100%-2rem)] max-w-lg border border-rule bg-surface p-0 text-ink shadow-float", backdrop)}
    >
      {props.open ? <OverlayBody {...props} /> : null}
    </dialog>
  );
}

/** Bottom sheet on mobile, right-hand panel from lg up. */
export function Sheet(props: OverlayProps) {
  const ref = useDialog(props.open, props.onClose);
  return (
    <dialog
      ref={ref}
      data-layer="floating"
      aria-label={props.title}
      className={cn(
        "mt-auto mb-0 max-h-[85dvh] w-full max-w-none border-t border-rule bg-surface p-0 text-ink shadow-float",
        "lg:my-0 lg:mr-0 lg:ml-auto lg:h-dvh lg:max-h-none lg:w-[28rem] lg:border-t-0 lg:border-l",
        backdrop,
      )}
    >
      {props.open ? <OverlayBody {...props} /> : null}
    </dialog>
  );
}
