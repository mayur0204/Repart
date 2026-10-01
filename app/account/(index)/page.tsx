import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { maskPhone } from "@/lib/phone";
import { requireMemberPage } from "@/server/auth/current";
import { signOut } from "../../sign-in/actions";
import { updateProfile } from "../actions";

export const metadata: Metadata = { title: "Account | RePart" };

const LINKS = [
  { href: "/garage", label: "Your garage", body: "Bikes you ride and parts that fit them." },
  { href: "/account/addresses", label: "Addresses", body: "Where parts are delivered and picked up." },
  { href: "/account/saved", label: "Saved parts", body: "Listings you saved to come back to." },
  { href: "/garage/searches", label: "Saved searches", body: "Searches that alert you to new matches." },
  { href: "/account/privacy", label: "Privacy", body: "Consents and requests for your data." },
];

export default async function AccountPage() {
  const user = await requireMemberPage("/account");
  return (
    <Page title="Account">
      <div className="grid gap-6 lg:grid-cols-12">
        <section className="flex flex-col gap-4 rounded-lg border border-rule bg-surface p-4 lg:col-span-7">
          <h2 className="text-xl">Profile</h2>
          <p className="text-steel">
            Signed in with <span className="num text-ink">{maskPhone(user.phone)}</span>. To change your number, sign in with the new one and contact support.
          </p>
          <ActionForm action={updateProfile} submitLabel="Save profile">
            <FormInput label="Name" name="name" autoComplete="name" defaultValue={user.name ?? ""} />
            <FormInput label="Email (optional)" name="email" type="email" autoComplete="email" defaultValue={user.email ?? ""} />
          </ActionForm>
        </section>
        <nav aria-label="Account" className="flex flex-col lg:col-span-5">
          <ul className="border border-rule bg-surface">
            {LINKS.map((l) => (
              <li key={l.href} className="border-b border-rule last:border-b-0">
                <Link href={l.href} className="flex min-h-11 flex-col p-4 hover:bg-page">
                  <span className="font-semibold text-action">{l.label}</span>
                  <span className="text-sm text-steel">{l.body}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <ActionForm action={signOut} submitLabel="Sign out" submitVariant="secondary" />
          </div>
        </nav>
      </div>
    </Page>
  );
}
