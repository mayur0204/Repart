import { NextResponse } from "next/server";
import { withNext } from "@/lib/return-to";
import { createSupabaseServerClient } from "@/server/auth/supabase";
import { defineRoute } from "@/server/http/define-route";

export const dynamic = "force-dynamic";

/**
 * GET /auth/callback: the email-confirmation link lands here (only when "Confirm email" is on in Supabase).
 * Swaps the one-time code for a session cookie. The RePart User already exists from sign-up.
 */
export const GET = defineRoute({ access: "public" }, async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const supabase = await createSupabaseServerClient();
  if (code && supabase && !(await supabase.auth.exchangeCodeForSession(code)).error) {
    return NextResponse.redirect(new URL(withNext("/sign-in/about-you", url.searchParams.get("next")), url.origin), 303);
  }
  return NextResponse.redirect(new URL("/sign-in?confirm=failed", url.origin), 303);
});
