import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { safeNext, withNext } from "@/lib/return-to";
import { getCurrentUser } from "@/server/auth/current";
import { currentAuthUserId } from "@/server/auth/supabase";
import { finishAccount } from "../actions";

export const metadata: Metadata = { title: "Finish your account | RePart" };

/** Reached from sign-in when the password was right but the login has no RePart account yet. */
export default async function FinishAccountPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentUser()) redirect(safeNext(next));
  if (!(await currentAuthUserId())) redirect(withNext("/sign-in", next));
  return (
    <Page title="Finish your account" intro="Add your mobile number to finish setting up your RePart account." narrow>
      <ActionForm action={finishAccount} submitLabel="Continue" fullWidthSubmit>
        <input type="hidden" name="next" value={next ?? ""} />
        <FormInput
          label="Mobile number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="98765 43210"
          autoFocus
          help="Indian mobile numbers only. Sellers and couriers use it for your orders."
        />
      </ActionForm>
    </Page>
  );
}
