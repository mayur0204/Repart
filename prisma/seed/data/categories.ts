import type { InspectionTier, ShippingRestriction } from "../../../src/generated/prisma/enums";

/**
 * Part categories with the brief's default tiers (REPART_BRIEF.md §6).
 * Checklists, photo guides, packaging guides and part-number hints are generic guidance,
 * not claims about any real vehicle. Fees and thresholds are illustrative development
 * defaults (paise) and are admin-editable.
 */

export type ChecklistItem = {
  id: string;
  question: string;
  weight: number; // deducted from 100 when answered "bad"
  badAnswer: "YES" | "NO";
  blocksListing: boolean;
};

export type PhotoShot = {
  shotType: string;
  label: string;
  instructions: string;
  required: boolean;
};

export type CategorySeed = {
  slug: string;
  name: string;
  parentSlug?: string;
  sortOrder: number;
  isSafetyCritical: boolean;
  inspectionTier: InspectionTier;
  inspectionValueThreshold?: number;
  optionalCheckFee: number;
  optionalCheckEnabled: boolean;
  shippingRestriction: ShippingRestriction;
  packagingGuide: string;
  partNumberHint?: string;
  conditionChecklist: ChecklistItem[];
  photoGuide: PhotoShot[];
};

const shot = (shotType: string, label: string, instructions: string, required = true): PhotoShot => ({
  shotType,
  label,
  instructions,
  required,
});

const q = (id: string, question: string, weight: number, badAnswer: "YES" | "NO", blocksListing = false): ChecklistItem => ({
  id,
  question,
  weight,
  badAnswer,
  blocksListing,
});

// Common shots reused across categories.
const FRONT = shot("front", "Front", "Whole part, flat on a plain surface, in daylight.");
const BACK = shot("back", "Back", "Turn the part over. Show the whole underside.");
const LABEL = shot("part-number", "Part number", "Close-up of the printed or stamped part number, in focus.", false);
const DAMAGE = shot("wear-or-damage", "Wear or damage", "Close-up of any wear, cracks or scratches. Skip if there are none.", false);

const TIER_B_THRESHOLD = 500_000; // ₹5,000, illustrative
const CHECK_FEE = 29_900; // ₹299, illustrative

const parent = (slug: string, name: string, sortOrder: number, tier: InspectionTier, safety: boolean): CategorySeed => ({
  slug,
  name,
  sortOrder,
  isSafetyCritical: safety,
  inspectionTier: tier,
  optionalCheckFee: 0,
  optionalCheckEnabled: false,
  shippingRestriction: "NONE",
  packagingGuide: "Choose a specific part type below.",
  conditionChecklist: [],
  photoGuide: [],
});

export const CATEGORIES: CategorySeed[] = [
  // ── Parents (grouping only) ──
  parent("brakes", "Brakes", 10, "C_ALWAYS", true),
  parent("wheels-and-tyres", "Wheels and tyres", 20, "C_ALWAYS", true),
  parent("suspension-and-steering", "Suspension and steering", 30, "C_ALWAYS", true),
  parent("engine-and-transmission", "Engine and transmission", 40, "B_CONDITIONAL", false),
  parent("electricals", "Electricals and lights", 50, "B_CONDITIONAL", false),
  parent("body", "Body and seating", 60, "A_AUTOMATED", false),
  parent("controls-and-accessories", "Controls and accessories", 70, "A_AUTOMATED", false),

  // ── Tier C: Partner Check before every sale ──
  {
    slug: "brake-pads",
    name: "Brake pads",
    parentSlug: "brakes",
    sortOrder: 11,
    isSafetyCritical: true,
    inspectionTier: "C_ALWAYS",
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "NONE",
    packagingGuide: "Wrap the pads in paper so the friction surface is not touched, then pack in a small box.",
    partNumberHint: "Usually printed on the metal backing plate.",
    conditionChecklist: [
      q("pad-thickness-ok", "Is there friction material left above the wear line?", 40, "NO", true),
      q("pad-contaminated", "Has the pad been soaked in oil or brake fluid?", 40, "YES", true),
      q("pad-cracked", "Is the friction material cracked or chipped?", 30, "YES", true),
      q("pad-backing-rust", "Is the backing plate rusty?", 10, "YES"),
    ],
    photoGuide: [FRONT, BACK, shot("edge", "Side view", "Side-on, showing how much friction material is left."), LABEL],
  },
  {
    slug: "brake-discs",
    name: "Brake discs",
    parentSlug: "brakes",
    sortOrder: 12,
    isSafetyCritical: true,
    inspectionTier: "C_ALWAYS",
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "NONE",
    packagingGuide: "Place the disc between two pieces of cardboard and pack flat so it cannot bend.",
    partNumberHint: "Often stamped on the inner ring or the disc face, with a minimum-thickness mark.",
    conditionChecklist: [
      q("disc-warped", "Does the disc look bent or warped?", 40, "YES", true),
      q("disc-cracked", "Are there cracks anywhere on the disc?", 50, "YES", true),
      q("disc-grooved", "Are there deep grooves on the braking surface?", 20, "YES"),
      q("disc-min-thickness", "Is the disc above its stamped minimum thickness?", 30, "NO", true),
    ],
    photoGuide: [FRONT, BACK, shot("surface", "Braking surface", "Angled close-up of the braking surface."), LABEL],
  },
  {
    slug: "brake-levers",
    name: "Brake levers",
    parentSlug: "brakes",
    sortOrder: 13,
    isSafetyCritical: true,
    inspectionTier: "C_ALWAYS",
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "NONE",
    packagingGuide: "Wrap in bubble wrap and pack in a small box.",
    partNumberHint: "Sometimes cast into the lever near the pivot.",
    conditionChecklist: [
      q("lever-bent", "Is the lever bent?", 40, "YES", true),
      q("lever-cracked", "Are there cracks near the pivot hole?", 50, "YES", true),
      q("lever-pivot-worn", "Is the pivot hole worn oval?", 20, "YES"),
    ],
    photoGuide: [FRONT, BACK, shot("pivot", "Pivot", "Close-up of the pivot hole."), LABEL],
  },
  {
    slug: "tyres",
    name: "Tyres",
    parentSlug: "wheels-and-tyres",
    sortOrder: 21,
    isSafetyCritical: true,
    inspectionTier: "C_ALWAYS",
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "OVERSIZE",
    packagingGuide: "Wrap the tyre in stretch film or a large bag and tape the size label so it can be read.",
    partNumberHint: "Size and manufacture date are moulded on the sidewall.",
    conditionChecklist: [
      q("tyre-tread-ok", "Is the tread above the wear indicators?", 40, "NO", true),
      q("tyre-sidewall-cuts", "Are there cuts or bulges on the sidewall?", 50, "YES", true),
      q("tyre-punctured", "Has the tyre been repaired for a puncture?", 20, "YES"),
      q("tyre-cracking", "Is there cracking in the rubber from age?", 20, "YES"),
    ],
    photoGuide: [
      shot("tread", "Tread", "Straight-on view of the tread."),
      shot("sidewall", "Sidewall", "Whole sidewall with the size marking."),
      shot("date-code", "Date code", "Close-up of the manufacture date code."),
      DAMAGE,
    ],
  },
  {
    slug: "wheels",
    name: "Wheels",
    parentSlug: "wheels-and-tyres",
    sortOrder: 22,
    isSafetyCritical: true,
    inspectionTier: "C_ALWAYS",
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "OVERSIZE",
    packagingGuide: "Protect the rim edge with cardboard and wrap the whole wheel in stretch film.",
    partNumberHint: "Often cast on the inside of the rim or a spoke.",
    conditionChecklist: [
      q("wheel-bent", "Is the rim bent or out of true?", 40, "YES", true),
      q("wheel-cracked", "Are there cracks in the rim or spokes?", 50, "YES", true),
      q("wheel-bearings-ok", "Do the bearings turn smoothly?", 15, "NO"),
    ],
    photoGuide: [FRONT, BACK, shot("rim-edge", "Rim edge", "Close-up around the rim edge."), LABEL],
  },
  {
    slug: "suspension",
    name: "Suspension",
    parentSlug: "suspension-and-steering",
    sortOrder: 31,
    isSafetyCritical: true,
    inspectionTier: "C_ALWAYS",
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "NONE",
    packagingGuide: "Cover the stanchions or shaft with foam so they cannot be scratched.",
    partNumberHint: "Usually on a sticker or stamp on the body of the shock or fork.",
    conditionChecklist: [
      q("susp-leaking", "Is there any oil leaking?", 40, "YES", true),
      q("susp-bent", "Is the shaft or fork tube bent?", 50, "YES", true),
      q("susp-pitted", "Is the chrome pitted or scratched?", 20, "YES"),
    ],
    photoGuide: [FRONT, BACK, shot("seal", "Seal area", "Close-up of the seal area."), LABEL],
  },
  {
    slug: "steering-parts",
    name: "Steering parts",
    parentSlug: "suspension-and-steering",
    sortOrder: 32,
    isSafetyCritical: true,
    inspectionTier: "C_ALWAYS",
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "NONE",
    packagingGuide: "Wrap each piece separately and fill gaps in the box.",
    partNumberHint: "Stamped on the yoke or printed on the packaging label.",
    conditionChecklist: [
      q("steer-cracked", "Are there cracks in any part?", 50, "YES", true),
      q("steer-bent", "Is any part bent?", 40, "YES", true),
      q("steer-bearing-notchy", "Do the bearings feel notchy?", 20, "YES"),
    ],
    photoGuide: [FRONT, BACK, LABEL, DAMAGE],
  },

  // ── Tier B: Partner Check above threshold or high risk; optional below ──
  {
    slug: "exhausts",
    name: "Exhausts",
    parentSlug: "engine-and-transmission",
    sortOrder: 41,
    isSafetyCritical: false,
    inspectionTier: "B_CONDITIONAL",
    inspectionValueThreshold: TIER_B_THRESHOLD,
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "OVERSIZE",
    packagingGuide: "Plug the pipe ends, wrap in cardboard and bubble wrap.",
    partNumberHint: "Usually stamped near the mounting bracket.",
    conditionChecklist: [
      q("exh-holes", "Are there holes or rust-through?", 40, "YES", true),
      q("exh-dents", "Are there dents?", 15, "YES"),
      q("exh-mounts-ok", "Are all mounting brackets intact?", 20, "NO"),
    ],
    photoGuide: [FRONT, BACK, shot("mounts", "Mounts", "Close-up of the mounting brackets."), LABEL],
  },
  {
    slug: "clutch-parts",
    name: "Clutch parts",
    parentSlug: "engine-and-transmission",
    sortOrder: 42,
    isSafetyCritical: false,
    inspectionTier: "B_CONDITIONAL",
    inspectionValueThreshold: TIER_B_THRESHOLD,
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "NONE",
    packagingGuide: "Keep plates together in a sealed bag, then pack in a small box.",
    partNumberHint: "Printed on the pressure plate or basket.",
    conditionChecklist: [
      q("clutch-burnt", "Do the plates look burnt or glazed?", 30, "YES"),
      q("clutch-warped", "Are any plates warped?", 40, "YES", true),
      q("clutch-complete", "Is the set complete?", 20, "NO"),
    ],
    photoGuide: [FRONT, BACK, LABEL, DAMAGE],
  },
  {
    slug: "clutch-levers",
    name: "Clutch levers",
    parentSlug: "engine-and-transmission",
    sortOrder: 43,
    isSafetyCritical: false,
    inspectionTier: "B_CONDITIONAL",
    inspectionValueThreshold: TIER_B_THRESHOLD,
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "NONE",
    packagingGuide: "Wrap in bubble wrap and pack in a small box.",
    partNumberHint: "Sometimes cast into the lever near the pivot.",
    conditionChecklist: [
      q("clever-bent", "Is the lever bent?", 30, "YES"),
      q("clever-cracked", "Are there cracks near the pivot hole?", 50, "YES", true),
    ],
    photoGuide: [FRONT, BACK, LABEL],
  },
  {
    slug: "engine-parts",
    name: "Engine parts",
    parentSlug: "engine-and-transmission",
    sortOrder: 44,
    isSafetyCritical: false,
    inspectionTier: "B_CONDITIONAL",
    inspectionValueThreshold: TIER_B_THRESHOLD,
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "NONE",
    packagingGuide: "Drain all oil, seal openings with tape and pack with padding on every side.",
    partNumberHint: "Cast or stamped on the part body.",
    conditionChecklist: [
      q("eng-cracked", "Are there cracks in the casting?", 50, "YES", true),
      q("eng-threads-ok", "Are all threads undamaged?", 20, "NO"),
      q("eng-scoring", "Is there scoring on any wear surface?", 30, "YES"),
    ],
    photoGuide: [FRONT, BACK, LABEL, DAMAGE],
  },
  {
    slug: "ecus-and-electricals",
    name: "ECUs and electricals",
    parentSlug: "electricals",
    sortOrder: 51,
    isSafetyCritical: false,
    inspectionTier: "B_CONDITIONAL",
    inspectionValueThreshold: TIER_B_THRESHOLD,
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "FRAGILE",
    packagingGuide: "Put the unit in an anti-static or plastic bag and surround it with padding.",
    partNumberHint: "Printed on a sticker on the casing.",
    conditionChecklist: [
      q("elec-works", "Was it working when removed?", 40, "NO"),
      q("elec-water", "Has it been exposed to water?", 30, "YES"),
      q("elec-connectors-ok", "Are all connectors undamaged?", 20, "NO"),
    ],
    photoGuide: [FRONT, BACK, shot("connectors", "Connectors", "Close-up of the connector pins."), LABEL],
  },
  {
    slug: "lights",
    name: "Lights",
    parentSlug: "electricals",
    sortOrder: 52,
    isSafetyCritical: false,
    inspectionTier: "B_CONDITIONAL",
    inspectionValueThreshold: TIER_B_THRESHOLD,
    optionalCheckFee: CHECK_FEE,
    optionalCheckEnabled: true,
    shippingRestriction: "FRAGILE",
    packagingGuide: "Wrap the lens in bubble wrap and pack with padding so it cannot move.",
    partNumberHint: "Moulded into the lens or on a sticker on the housing.",
    conditionChecklist: [
      q("light-lens-cracked", "Is the lens cracked?", 30, "YES"),
      q("light-works", "Does it light up?", 40, "NO"),
      q("light-mounts-ok", "Are all mounting tabs intact?", 20, "NO"),
    ],
    photoGuide: [FRONT, BACK, shot("lit", "Switched on", "The light switched on, if you can.", false), LABEL],
  },

  // ── Tier A: automated checks only (optional check off by default) ──
  {
    slug: "mirrors",
    name: "Mirrors",
    parentSlug: "body",
    sortOrder: 61,
    isSafetyCritical: false,
    inspectionTier: "A_AUTOMATED",
    optionalCheckFee: 0,
    optionalCheckEnabled: false,
    shippingRestriction: "FRAGILE",
    packagingGuide: "Tape a piece of cardboard over the glass and wrap in bubble wrap.",
    partNumberHint: "On the back of the housing or the stem.",
    conditionChecklist: [
      q("mirror-glass-cracked", "Is the glass cracked?", 40, "YES"),
      q("mirror-stem-bent", "Is the stem bent?", 20, "YES"),
      q("mirror-threads-ok", "Is the mounting thread undamaged?", 20, "NO"),
    ],
    photoGuide: [FRONT, BACK, shot("mount", "Mount", "Close-up of the mounting thread.")],
  },
  {
    slug: "body-panels-and-fairings",
    name: "Body panels and fairings",
    parentSlug: "body",
    sortOrder: 62,
    isSafetyCritical: false,
    inspectionTier: "A_AUTOMATED",
    optionalCheckFee: 0,
    optionalCheckEnabled: false,
    shippingRestriction: "OVERSIZE",
    packagingGuide: "Wrap in bubble wrap, protect corners and mounting tabs with cardboard.",
    partNumberHint: "Moulded on the inside face.",
    conditionChecklist: [
      q("panel-cracked", "Are there cracks?", 30, "YES"),
      q("panel-tabs-ok", "Are all mounting tabs intact?", 25, "NO"),
      q("panel-scratched", "Are there deep scratches?", 10, "YES"),
    ],
    photoGuide: [FRONT, BACK, shot("tabs", "Mounting tabs", "Close-up of the mounting tabs."), DAMAGE],
  },
  {
    slug: "seats",
    name: "Seats",
    parentSlug: "body",
    sortOrder: 63,
    isSafetyCritical: false,
    inspectionTier: "A_AUTOMATED",
    optionalCheckFee: 0,
    optionalCheckEnabled: false,
    shippingRestriction: "OVERSIZE",
    packagingGuide: "Wrap in a large plastic bag and then cardboard.",
    partNumberHint: "On a label under the seat base.",
    conditionChecklist: [
      q("seat-torn", "Is the cover torn?", 25, "YES"),
      q("seat-base-cracked", "Is the base cracked?", 30, "YES"),
      q("seat-lock-ok", "Does the lock or latch work?", 15, "NO"),
    ],
    photoGuide: [FRONT, BACK, shot("base", "Base", "Underside of the seat base.")],
  },
  {
    slug: "grips",
    name: "Grips",
    parentSlug: "controls-and-accessories",
    sortOrder: 71,
    isSafetyCritical: false,
    inspectionTier: "A_AUTOMATED",
    optionalCheckFee: 0,
    optionalCheckEnabled: false,
    shippingRestriction: "NONE",
    packagingGuide: "Pack in a small box or padded envelope.",
    partNumberHint: "Printed on the grip end or packaging.",
    conditionChecklist: [
      q("grip-torn", "Is the rubber torn?", 30, "YES"),
      q("grip-worn", "Is the pattern worn smooth?", 15, "YES"),
    ],
    photoGuide: [FRONT, BACK, shot("ends", "Ends", "Both ends of the grip.")],
  },
  {
    slug: "accessories",
    name: "Accessories",
    parentSlug: "controls-and-accessories",
    sortOrder: 72,
    isSafetyCritical: false,
    inspectionTier: "A_AUTOMATED",
    optionalCheckFee: 0,
    optionalCheckEnabled: false,
    shippingRestriction: "NONE",
    packagingGuide: "Pack with padding so nothing moves in the box.",
    partNumberHint: "Check labels or packaging.",
    conditionChecklist: [
      q("acc-complete", "Is it complete with all fittings?", 25, "NO"),
      q("acc-damaged", "Is anything broken?", 30, "YES"),
    ],
    photoGuide: [FRONT, BACK, DAMAGE],
  },
];
