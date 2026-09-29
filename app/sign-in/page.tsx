import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { safeNext } from "@/lib/return-to";
import { getCurrentUser } from "@/server/auth/current";
import { requestCode } from "./actions";

export const metadata: Metadata = { title: "Sign in | RePart" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentUser()) redirect(safeNext(next));
  return (
    <Page title="Sign in or create an account" intro="We'll send a 6-digit code to your mobile. No password needed." narrow>
      <ActionForm action={requestCode} submitLabel="Send code" fullWidthSubmit>
        <input type="hidden" name="next" value={next ?? ""} />
        <FormInput
          label="Mobile number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="98765 43210"
          help="Indian mobile numbers only. Standard SMS rates may apply."
          autoFocus
        />
      </ActionForm>
    </Page>
  );
}
