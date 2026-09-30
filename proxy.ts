import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, originOf } from "@/lib/security-headers";

/**
 * Runs on every page request. Two jobs, no DB access:
 * 1. Content-Security-Policy with a fresh nonce (Next.js docs "Content Security Policy": the nonce is read back from
 *    the request header during rendering and applied to Next's own scripts).
 * 2. Coarse redirects for signed-in areas (PLAN.md §1.2 "Auth"). Pages and actions do the real checks through
 *    requireMemberPage / defineAction. Also rolls the session cookie's lifetime forward, matching the 30-day rolling
 *    expiry the server keeps in the Session table.
 */
const SESSION_COOKIE = "repart_session"; // keep in sync with src/server/auth/cookies.ts
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PROTECTED = /^\/(account|garage|admin|sell|seller|messages)(\/|$)|^\/sign-in\/add-bike$/;

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy({
    nonce,
    storageOrigins: [originOf(process.env.STORAGE_PROVIDER === "minio" ? process.env.MINIO_ENDPOINT : process.env.SUPABASE_URL)],
    dev: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
  });

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const { pathname, search } = request.nextUrl;
  let response: NextResponse;
  if (!token && PROTECTED.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    response = NextResponse.redirect(url);
  } else {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
    response = NextResponse.next({ request: { headers: requestHeaders } });
    if (token && PROTECTED.test(pathname)) {
      response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: MAX_AGE_SECONDS });
    }
  }
  response.headers.set("Content-Security-Policy", csp);
  // Lets the service worker drop cached pages when someone signs in or out on this device (public/sw.js).
  response.headers.set("X-Repart-Session", token ? "1" : "0");
  return response;
}

export const config = {
  // Every page; not API routes (they get a static CSP in next.config.ts), build assets, the service worker or icons.
  matcher: ["/((?!api/|_next/static|_next/image|sw\\.js|icon|icons/|manifest\\.webmanifest|favicon\\.ico).*)"],
};
