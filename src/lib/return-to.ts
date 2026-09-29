/**
 * Return-to handling for sign-in (REPART_BRIEF.md §9: "return to where the user was").
 * Only same-site relative paths are allowed, so `next` can never become an open redirect.
 */
const BLOCKED_PREFIXES = ["/sign-in", "/api/"];

export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || typeof next !== "string") return fallback;
  let value: string;
  try {
    value = decodeURIComponent(next).trim();
  } catch {
    return fallback;
  }
  // Must be a single-slash absolute path: rejects "//evil.com", "/\\evil.com", "https://...", "javascript:".
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\u0000-\u001f]/.test(value)) {
    return fallback;
  }
  if (BLOCKED_PREFIXES.some((p) => value === p || value.startsWith(p.endsWith("/") ? p : `${p}/`) || value.startsWith(`${p}?`))) {
    return fallback;
  }
  return value;
}

/** Appends ?next= to a path when next is meaningful. */
export function withNext(path: string, next: string | null | undefined): string {
  const safe = safeNext(next, "");
  return safe && safe !== "/" ? `${path}?next=${encodeURIComponent(safe)}` : path;
}
