import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, FormInput, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { maskPhone } from "@/lib/phone";
import { withNext } from "@/lib/return-to";
import { readOtpChallengeId } from "@/server/auth/cookies";
import { signIn } from "@/server/services";
import { resendCode, verifyCode } from "../actions";

export const metadata: Metadata = { title: "Enter your code | RePart" };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const challengeId = await readOtpChallengeId();
  const challenge = challengeId ? await signIn.pendingChallenge(challengeId) : null;
  if (!challenge) redirect(withNext("/sign-in", next));

  return (
    <Page title="Enter your code" intro={`We sent a 6-digit code to ${maskPhone(challenge.phone)}. It works for 5 minutes.`} narrow>
      <ActionForm action={verifyCode} submitLabel="Sign in" fullWidthSubmit>
        <input type="hidden" name="next" value={next ?? ""} />
        <FormInput label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" autoFocus />
      </ActionForm>
      <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-4">
        <InlineAction action={resendCode} label="Send a new code" />
        <Link href={withNext("/sign-in", next)} className="text-action underline-offset-4 hover:underline">
          Use a different number
        </Link>
      </div>
    </Page>
  );
}
