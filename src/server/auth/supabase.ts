import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieOptions, supabaseAuthConfig } from "@/lib/supabase-auth";

/** A per-request Supabase client bound to the request's cookies, or null when Supabase Auth isn't configured. */
export async function createSupabaseServerClient() {
  const config = supabaseAuthConfig();
  if (!config) return null;
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll: () => store.getAll(),
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // Server Components can't set cookies. proxy.ts refreshes the session on every page request instead.
        }
      },
    },
  });
}

export type SupabaseAuth = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>["auth"];

/** The verified Supabase Auth user id (JWT `sub`) for this request, or null. */
export async function currentAuthUserId(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getClaims();
  return data?.claims.sub ?? null;
}
