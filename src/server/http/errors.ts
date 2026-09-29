import "server-only";

/**
 * Errors that services throw and the action/route wrappers turn into user-facing results.
 * Messages say what happened and how to fix it (REPART_BRIEF.md §10 "Writing").
 */
export class UserError extends Error {
  readonly kind = "user";
}

export class FieldError extends Error {
  readonly kind = "field";
  constructor(readonly fieldErrors: Record<string, string>) {
    super(Object.values(fieldErrors)[0] ?? "Check the highlighted fields.");
  }
}

export class NotSignedInError extends Error {
  readonly kind = "unauthenticated";
  constructor() {
    super("Sign in to continue.");
  }
}

export class ForbiddenError extends Error {
  readonly kind = "forbidden";
  constructor() {
    super("Your account can't do that.");
  }
}

export class NotFoundError extends Error {
  readonly kind = "not_found";
  constructor(what = "item") {
    super(`That ${what} doesn't exist or isn't yours.`);
  }
}

export class RateLimitedError extends Error {
  readonly kind = "rate_limited";
  constructor(readonly retryAfterSeconds: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    super(`Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
}
