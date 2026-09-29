import "server-only";
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import type { Role } from "@/generated/prisma/client";
import { clientIp, getCurrentUser } from "../auth/current";
import type { SessionUser } from "../auth/session";
import { logger } from "../logger";
import { FieldError, ForbiddenError, NotFoundError, NotSignedInError, RateLimitedError, UserError } from "./errors";

/**
 * RBAC + validation wrappers (PLAN.md §1.2 "RBAC"). Every server action and route handler
 * in app/** must be built with one of these; tests/unit/wrapped.test.ts enforces it.
 *
 * access: "public" (anyone), "member" (any signed-in active user), or a list of roles (any one suffices).
 */
export type Access = "public" | "member" | readonly Role[];

export type ActionState = { ok: boolean; message?: string; fieldErrors?: Record<string, string> } | null;

export type ActionContext<A extends Access> = {
  user: A extends "public" ? SessionUser | null : SessionUser;
  ip: string;
  requestId: string;
};

export const WRAPPED = Symbol.for("repart.wrapped");

export function authorize(access: Access, user: SessionUser | null): void {
  if (access === "public") return;
  if (!user) throw new NotSignedInError();
  if (access === "member") return;
  if (!access.some((role) => user.roles.includes(role))) throw new ForbiddenError();
}

/**
 * FormData → plain object. Repeated keys become arrays. File entries are dropped unless `keepFiles`
 * is set: photos use signed uploads, and only small admin files (CSV imports) pass through actions.
 */
export function formDataToObject(formData: FormData, keepFiles = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION") || (typeof value !== "string" && !keepFiles)) continue;
    const prev = out[key];
    out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Converts a thrown error into the state a form displays. Unknown errors are logged, never shown. */
export function toActionState(err: unknown, requestId: string): ActionState {
  if (err instanceof z.ZodError) return { ok: false, fieldErrors: zodFieldErrors(err), message: "Check the highlighted fields." };
  if (err instanceof FieldError) return { ok: false, fieldErrors: err.fieldErrors, message: err.message };
  if (
    err instanceof UserError ||
    err instanceof NotSignedInError ||
    err instanceof ForbiddenError ||
    err instanceof NotFoundError ||
    err instanceof RateLimitedError
  ) {
    return { ok: false, message: err.message };
  }
  logger.error({ requestId, err: err instanceof Error ? err.message : String(err) }, "action failed");
  return { ok: false, message: `That didn't work because of a problem on our side. Try again in a moment (ref ${requestId.slice(0, 8)}).` };
}

export function defineAction<S extends z.ZodType, A extends Access>(
  opts: { input: S; access: A; files?: boolean },
  handler: (input: z.infer<S>, ctx: ActionContext<A>) => Promise<ActionState | void>,
) {
  const action = async (_prev: ActionState, formData: FormData): Promise<ActionState> => {
    const requestId = randomUUID();
    try {
      const user = await getCurrentUser();
      authorize(opts.access, user);
      const input = opts.input.parse(formDataToObject(formData, opts.files));
      const ctx = { user, ip: await clientIp(), requestId } as ActionContext<A>;
      return (await handler(input, ctx)) ?? { ok: true };
    } catch (err) {
      unstable_rethrow(err); // let redirect()/notFound() through
      return toActionState(err, requestId);
    }
  };
  return Object.assign(action, { [WRAPPED]: true as const });
}
