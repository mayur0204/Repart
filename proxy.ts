import { NextResponse, type NextRequest } from "next/server";

/**
 * Coarse redirects only (PLAN.md §1.2 "Auth"): no DB access here. Pages and actions do the real
 * checks through requireMemberPage / defineAction. Also rolls the session cookie's lifetime forward,
 * matching the 30-day rolling expiry the server keeps in the Session table.
 */
const SESSION_COOKIE = "repart_session"; // keep in sync with src/server/auth/cookies.ts
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  const response = NextResponse.next();
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: MAX_AGE_SECONDS });
  return response;
}

export const config = {
  matcher: ["/account/:path*", "/garage/:path*", "/admin/:path*", "/sell/:path*", "/seller/:path*", "/sign-in/add-bike"],
};
