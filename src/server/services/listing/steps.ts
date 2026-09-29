import { gradeFromChecklist, type ChecklistAnswers, type ChecklistItem, type GradeThresholds, type StepSlug } from "@/lib/listing";

/**
 * Which wizard steps are complete, and what is still missing (REPART_BRIEF.md §9: each step validates
 * before continuing; Review needs every step). Pure, so the submit guard and the UI agree.
 */
export type StepInput = {
  listing: {
    partNumberId: string | null;
    partName: string | null;
    categoryId: string | null;
    checklistAnswers: unknown;
    description: string | null;
    pricePaise: number | null;
    pickupAddressId: string | null;
    weightBand: string | null;
    dimensionBand: string | null;
  };
  hasSellerBike: boolean;
  checklist: ChecklistItem[];
  requiredShots: Array<{ shotType: string; label: string }>;
  photos: Array<{ shotType: string; status: "processing" | "ready" | "failed" }>;
  settings: { minPhotos: number; grading: GradeThresholds };
};

export type StepReport = Record<StepSlug, string[]>;

export const MIN_DESCRIPTION = 30;
export const MAX_DESCRIPTION = 2000;

export function checkSteps(input: StepInput): StepReport {
  const { listing: l } = input;
  const report: StepReport = { bike: [], part: [], condition: [], photos: [], details: [], price: [], review: [] };

  if (!input.hasSellerBike) report.bike.push("Choose the bike this part came from.");
  if (!l.partNumberId || !l.categoryId) report.part.push("Choose the part number from our catalogue.");
  if (!l.partName?.trim()) report.part.push("Enter the part name.");

  if (!l.categoryId) report.condition.push("Choose the part first, so we can show the right checklist.");
  else {
    const answers = (l.checklistAnswers ?? {}) as ChecklistAnswers;
    const { unanswered, blocking } = gradeFromChecklist(input.checklist, answers, input.settings.grading);
    if (unanswered.length) report.condition.push(`Answer all ${input.checklist.length} checklist questions (${unanswered.length} left).`);
    for (const q of blocking) report.condition.push(`This part can't be listed because of: "${q}".`);
  }

  const ready = input.photos.filter((p) => p.status === "ready");
  if (input.photos.some((p) => p.status === "processing")) report.photos.push("Wait for your photos to finish uploading.");
  if (input.photos.some((p) => p.status === "failed")) report.photos.push("Remove the photos that couldn't be used, then add them again.");
  if (ready.length < input.settings.minPhotos) report.photos.push(`Add at least ${input.settings.minPhotos} photos (${ready.length} so far).`);
  for (const shot of input.requiredShots) {
    if (!ready.some((p) => p.shotType === shot.shotType)) report.photos.push(`Add the "${shot.label}" photo.`);
  }

  const description = l.description?.trim() ?? "";
  if (description.length < MIN_DESCRIPTION) report.details.push(`Write a description of at least ${MIN_DESCRIPTION} characters.`);

  if (!l.pricePaise) report.price.push("Set a price.");
  if (!l.pickupAddressId) report.price.push("Choose a pickup address.");
  if (!l.weightBand || !l.dimensionBand) report.price.push("Choose the packed weight and size.");

  const incomplete = (Object.keys(report) as StepSlug[]).filter((k) => k !== "review" && report[k].length > 0);
  if (incomplete.length) report.review.push("Finish the steps marked as incomplete.");
  return report;
}

export const allStepsComplete = (r: StepReport) => Object.values(r).every((p) => p.length === 0);
