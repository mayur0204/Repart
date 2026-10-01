/**
 * Supabase Auth settings shared by proxy.ts and the server. Supabase Auth answers "who is this?";
 * RePart's User table (roles, status) answers "what may they do?". Only browser-safe values live here:
 * the project URL and publishable key. The service-role key is never used for auth.
 */
export function supabaseAuthConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url, key } : null;
}

/** Auth cookies: no browser Supabase client reads them, so they can be httpOnly. Secure on HTTPS deployments (Vercel). */
export const authCookieOptions = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
} as const;

/** Supabase SSR stores the session in cookies named sb-<project-ref>-auth-token (possibly chunked: .0, .1). */
export const isSupabaseAuthCookie = (name: string) => name.startsWith("sb-") && name.includes("-auth-token");
