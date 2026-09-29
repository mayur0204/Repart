"use client";

import { createContext, useActionState, useContext, useEffect, type ComponentProps, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

/** Mirrors ActionState in src/server/http/define-action.ts (kept structural so this stays client-safe). */
export type FormState = { ok: boolean; message?: string; fieldErrors?: Record<string, string> } | null;
export type FormAction = (prev: FormState, formData: FormData) => Promise<FormState>;

const FormStateContext = createContext<{ state: FormState; pending: boolean }>({ state: null, pending: false });
export const useFormState = () => useContext(FormStateContext);

/**
 * A form bound to a server action built with defineAction. Field errors reach FormInput/FormSelect
 * through context; a success message is shown as a toast.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  submitVariant = "primary",
  className,
  fullWidthSubmit,
  extraActions,
}: {
  action: FormAction;
  children?: ReactNode;
  submitLabel: string;
  submitVariant?: ButtonVariant;
  className?: string;
  fullWidthSubmit?: boolean;
  extraActions?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const toast = useToast();
  useEffect(() => {
    if (state?.ok && state.message) toast(state.message, "success");
  }, [state, toast]);

  return (
    <form action={formAction} className={cn("flex flex-col gap-4", className)} noValidate>
      <FormStateContext.Provider value={{ state, pending }}>
        {state && !state.ok && state.message ? (
          <p role="alert" className="flex items-start gap-2 border border-danger bg-danger-tint p-3 text-danger">
            <Icon name="error" className="mt-0.5 shrink-0" />
            {state.message}
          </p>
        ) : null}
        {children}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant={submitVariant} disabled={pending} fullWidth={fullWidthSubmit}>
            {submitLabel}
          </Button>
          {extraActions}
        </div>
      </FormStateContext.Provider>
    </form>
  );
}

export function FormInput(props: ComponentProps<typeof Input> & { name: string }) {
  const { state } = useFormState();
  return <Input {...props} error={props.error ?? state?.fieldErrors?.[props.name]} />;
}

export function FormSelect(props: ComponentProps<typeof Select> & { name: string }) {
  const { state } = useFormState();
  return <Select {...props} error={props.error ?? state?.fieldErrors?.[props.name]} />;
}

export function FormTextarea(props: ComponentProps<typeof Textarea> & { name: string }) {
  const { state } = useFormState();
  return <Textarea {...props} error={props.error ?? state?.fieldErrors?.[props.name]} />;
}

/** A one-button form, e.g. "Make primary" or "Delete". Pass hidden fields as children. */
export function InlineAction({
  action,
  label,
  variant = "tertiary",
  children,
}: {
  action: FormAction;
  label: string;
  variant?: ButtonVariant;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const toast = useToast();
  useEffect(() => {
    if (state?.message) toast(state.message, state.ok ? "success" : "error");
  }, [state, toast]);
  return (
    <form action={formAction}>
      {children}
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
    </form>
  );
}
