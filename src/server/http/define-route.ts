import "server-only";
import { randomUUID } from "node:crypto";
import { getCurrentUser } from "../auth/current";
import type { SessionUser } from "../auth/session";
import { logger } from "../logger";
import { authorize, WRAPPED, type Access } from "./define-action";
import { ForbiddenError, NotFoundError, NotSignedInError, RateLimitedError, UserError } from "./errors";

/** Route-handler counterpart of defineAction: access check + JSON errors. */
export function defineRoute<A extends Access>(
  opts: { access: A },
  handler: (req: Request, ctx: { user: SessionUser | null; requestId: string }) => Promise<Response>,
) {
  const route = async (req: Request): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const user = opts.access === "public" ? null : await getCurrentUser();
      authorize(opts.access, user);
      return await handler(req, { user, requestId });
    } catch (err) {
      const status =
        err instanceof NotSignedInError ? 401
        : err instanceof ForbiddenError ? 403
        : err instanceof NotFoundError ? 404
        : err instanceof RateLimitedError ? 429
        : err instanceof UserError ? 400
        : 500;
      if (status === 500) logger.error({ requestId, err: err instanceof Error ? err.message : String(err) }, "route failed");
      const message = status === 500 ? "Internal error" : (err as Error).message;
      return Response.json({ error: message, requestId }, { status });
    }
  };
  return Object.assign(route, { [WRAPPED]: true as const });
}
