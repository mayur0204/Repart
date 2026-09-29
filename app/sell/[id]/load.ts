import "server-only";
import { notFound, redirect } from "next/navigation";
import type { StepSlug } from "@/lib/listing";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { listings } from "@/server/services";

/** Loads the signed-in seller's listing for a wizard step. Other people's listings are a 404. */
export async function loadStep(id: string, step: StepSlug) {
  const user = await requireMemberPage(`/sell/${id}/${step}`);
  const state = await listings.wizard(user.id, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  if (!state.editable) redirect(`/sell/${id}/status`);
  const incomplete = (Object.keys(state.steps) as StepSlug[]).filter((k) => state.steps[k].length > 0);
  return { user, state, incomplete, reached: state.listing.wizardStep };
}
