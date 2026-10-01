import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { safeNext, withNext } from "@/lib/return-to";
import { getCurrentUser } from "@/server/auth/current";
import { signInWithPassword } from "./actions";

export const metadata: Metadata = { title: "Sign in | RePart" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; confirm?: string }> }) {
  const { next, confirm } = await searchParams;
  if (await getCurrentUser()) redirect(safeNext(next));
  return (
    <Page title="Sign in" intro="Use the email and password for your RePart account." narrow>
      {confirm === "failed" ? (
        <p role="alert" className="rounded-lg border border-danger bg-danger-tint p-3 text-danger">
          That confirmation link has expired or was already used. Sign in, or create your account again.
        </p>
      ) : null}
      <ActionForm action={signInWithPassword} submitLabel="Sign in" fullWidthSubmit>
        <input type="hidden" name="next" value={next ?? ""} />
        <FormInput label="Email" name="email" type="email" autoComplete="email" inputMode="email" autoFocus />
        <FormInput label="Password" name="password" type="password" autoComplete="current-password" />
      </ActionForm>
      <p className="border-t border-rule pt-4">
        New to RePart?{" "}
        <Link href={withNext("/sign-in/create-account", next)} className="text-action underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </Page>
  );
}
