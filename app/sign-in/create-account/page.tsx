import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { safeNext, withNext } from "@/lib/return-to";
import { getCurrentUser } from "@/server/auth/current";
import { createAccount } from "../actions";

export const metadata: Metadata = { title: "Create an account | RePart" };

export default async function CreateAccountPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentUser()) redirect(safeNext(next));
  return (
    <Page title="Create an account" intro="Buy and sell used bike parts with checked fitment." narrow>
      <ActionForm action={createAccount} submitLabel="Create account" fullWidthSubmit>
        <input type="hidden" name="next" value={next ?? ""} />
        <FormInput label="Email" name="email" type="email" autoComplete="email" inputMode="email" autoFocus />
        <FormInput label="Password" name="password" type="password" autoComplete="new-password" minLength={8} help="At least 8 characters." />
        <FormInput
          label="Mobile number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="98765 43210"
          help="Indian mobile numbers only. Sellers and couriers use it for your orders."
        />
      </ActionForm>
      <p className="border-t border-rule pt-4">
        Already have an account?{" "}
        <Link href={withNext("/sign-in", next)} className="text-action underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </Page>
  );
}
