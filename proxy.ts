import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, originOf } from "@/lib/security-headers";
import { authCookieOptions, isSupabaseAuthCookie, supabaseAuthConfig } from "@/lib/supabase-auth";

/**
 * Runs on every page request. Two jobs, no DB access:
 * 1. Content-Security-Policy with a fresh nonce (Next.js docs "Content Security Policy": the nonce is read back from
 *    the request header during rendering and applied to Next's own scripts).
 * 2. Coarse redirects for signed-in areas (PLAN.md §1.2 "Auth"). Pages and actions do the real checks through
 *    requireMemberPage / defineAction. Also rolls the session cookie's lifetime forward, matching the 30-day rolling
 *    expiry the server keeps in the Session table.
 * 3. Refreshes the Supabase Auth session (the SSR cookie pattern): Server Components can't write cookies, so expired
 *    access tokens are renewed here and passed on to both the page render and the browser.
 */
const SESSION_COOKIE = "repart_session"; // keep in sync with src/server/auth/cookies.ts
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PROTECTED = /^\/(account|garage|admin|sell|seller|messages)(\/|$)|^\/sign-in\/add-bike$/;

type AuthCookie = { name: string; value: string; options: CookieOptions };

/** Verifies (and if needed refreshes) the Supabase session. Skips the network entirely when there's no auth cookie. */
async function refreshSupabaseSession(request: NextRequest) {
  const config = supabaseAuthConfig();
  const result = { signedIn: false, cookies: [] as AuthCookie[], headers: {} as Record<string, string> };
  if (!config || !request.cookies.getAll().some((c) => isSupabaseAuthCookie(c.name))) return result;
  const supabase = createServerClient(config.url, config.key, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(toSet, headers) {
        for (const c of toSet) request.cookies.set(c.name, c.value); // the page render sees the fresh tokens
        result.cookies.push(...toSet);
        result.headers = headers;
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  result.signedIn = !!data?.claims;
  return result;
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy({
    nonce,
    storageOrigins: [originOf(process.env.STORAGE_PROVIDER === "minio" ? process.env.MINIO_ENDPOINT : process.env.SUPABASE_URL)],
    dev: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
  });

  const auth = await refreshSupabaseSession(request);
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const signedIn = !!token || auth.signedIn;
  const { pathname, search } = request.nextUrl;
  let response: NextResponse;
  if (!signedIn && PROTECTED.test(pathname)) {
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
  for (const c of auth.cookies) response.cookies.set(c.name, c.value, c.options);
  for (const [key, value] of Object.entries(auth.headers)) response.headers.set(key, value);
  response.headers.set("Content-Security-Policy", csp);
  // Lets the service worker drop cached pages when someone signs in or out on this device (public/sw.js).
  response.headers.set("X-Repart-Session", signedIn ? "1" : "0");
  return response;
}

export const config = {
  // Every page; not API routes (they get a static CSP in next.config.ts), build assets, the service worker or icons.
  matcher: ["/((?!api/|_next/static|_next/image|sw\\.js|icon|icons/|manifest\\.webmanifest|favicon\\.ico).*)"],
};
