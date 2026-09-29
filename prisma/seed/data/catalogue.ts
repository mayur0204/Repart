import type {
  FitmentSource,
  InterchangeSource,
  InterchangeType,
  ReviewStatus,
  VehicleType,
} from "../../../src/generated/prisma/enums";

/**
 * SAMPLE catalogue (PLAN.md §11, decision D-4). Every make, model, part number and
 * fitment here is FICTIONAL. Nothing in this file claims real-world compatibility.
 * Part numbers use the SAMPLE-<category>-<nnnn> format so they cannot collide with
 * a real manufacturer number.
 */

export const SAMPLE_MAKES = [
  { id: "sample-make-sample-motors", name: "Sample Motors", slug: "sample-motors" },
  { id: "sample-make-demo-wheels", name: "Demo Wheels (sample)", slug: "demo-wheels" },
] as const;

export const SAMPLE_MODELS: { id: string; makeId: string; name: string; slug: string; vehicleType: VehicleType }[] = [
  { id: "sample-model-street-150", makeId: "sample-make-sample-motors", name: "Street 150", slug: "street-150", vehicleType: "MOTORCYCLE" },
  { id: "sample-model-roadster-200", makeId: "sample-make-sample-motors", name: "Roadster 200", slug: "roadster-200", vehicleType: "MOTORCYCLE" },
  { id: "sample-model-city-125", makeId: "sample-make-sample-motors", name: "City 125", slug: "city-125", vehicleType: "SCOOTER" },
  { id: "sample-model-demo-scoot-110", makeId: "sample-make-demo-wheels", name: "Scoot 110", slug: "scoot-110", vehicleType: "SCOOTER" },
];

export const SAMPLE_VARIANTS = [
  { id: "sample-variant-street-150-std", modelId: "sample-model-street-150", name: "Standard", yearFrom: 2018, yearTo: 2021, engineCc: 150 },
  { id: "sample-variant-street-150-disc", modelId: "sample-model-street-150", name: "Disc", yearFrom: 2020, yearTo: null, engineCc: 150 },
  { id: "sample-variant-roadster-200-std", modelId: "sample-model-roadster-200", name: "Standard", yearFrom: 2019, yearTo: null, engineCc: 200 },
  { id: "sample-variant-roadster-200-abs", modelId: "sample-model-roadster-200", name: "ABS", yearFrom: 2021, yearTo: null, engineCc: 200 },
  { id: "sample-variant-city-125-std", modelId: "sample-model-city-125", name: "Standard", yearFrom: 2017, yearTo: 2022, engineCc: 125 },
  { id: "sample-variant-city-125-conn", modelId: "sample-model-city-125", name: "Connected", yearFrom: 2022, yearTo: null, engineCc: 125 },
  { id: "sample-variant-demo-scoot-110-std", modelId: "sample-model-demo-scoot-110", name: "Standard", yearFrom: 2016, yearTo: null, engineCc: 110 },
] as const;

export type SamplePartNumber = { id: string; display: string; brand: string; isOem: boolean; categorySlug: string };

export const SAMPLE_PART_NUMBERS: SamplePartNumber[] = [
  // Brake pads (safety-critical)
  { id: "sample-pn-brk-0001", display: "SAMPLE-BRK-0001", brand: "Sample Motors", isOem: true, categorySlug: "brake-pads" },
  { id: "sample-pn-brk-0002", display: "SAMPLE-BRK-0002", brand: "Sample Aftermarket", isOem: false, categorySlug: "brake-pads" },
  { id: "sample-pn-brk-0003", display: "SAMPLE-BRK-0003", brand: "Sample Motors", isOem: true, categorySlug: "brake-pads" },
  { id: "sample-pn-brk-0004", display: "SAMPLE-BRK 0004", brand: "Sample Aftermarket", isOem: false, categorySlug: "brake-pads" },
  // Mirrors (not safety-critical)
  { id: "sample-pn-mir-0001", display: "SAMPLE-MIR-0001", brand: "Sample Motors", isOem: true, categorySlug: "mirrors" },
  { id: "sample-pn-mir-0002", display: "SAMPLE-MIR-0002", brand: "Sample Aftermarket", isOem: false, categorySlug: "mirrors" },
  { id: "sample-pn-mir-0003", display: "SAMPLE-MIR-0003", brand: "Sample Aftermarket", isOem: false, categorySlug: "mirrors" },
  // Exhaust, lights, seat
  { id: "sample-pn-exh-0001", display: "SAMPLE-EXH-0001", brand: "Sample Motors", isOem: true, categorySlug: "exhausts" },
  { id: "sample-pn-lgt-0001", display: "SAMPLE-LGT-0001", brand: "Sample Motors", isOem: true, categorySlug: "lights" },
  { id: "sample-pn-lgt-0002", display: "SAMPLE-LGT-0002", brand: "Sample Aftermarket", isOem: false, categorySlug: "lights" },
  { id: "sample-pn-set-0001", display: "SAMPLE-SET-0001", brand: "Sample Motors", isOem: true, categorySlug: "seats" },
  // Tyre / wheel
  { id: "sample-pn-whl-0001", display: "SAMPLE-WHL-0001", brand: "Sample Motors", isOem: true, categorySlug: "wheels" },
];

export type SampleLink = {
  id: string;
  a: string;
  b: string;
  type: InterchangeType;
  source: InterchangeSource;
  status: ReviewStatus;
  notes?: string;
};

/** Covers every link type, source and status for interchange tests (PLAN.md §11). */
export const SAMPLE_LINKS: SampleLink[] = [
  // Safety-critical: brand cross-reference must NOT count toward compatibility.
  { id: "sample-link-brk-1-2", a: "sample-pn-brk-0001", b: "sample-pn-brk-0002", type: "EXACT_EQUIVALENT", source: "BRAND_CROSS_REFERENCE", status: "APPROVED" },
  // Supersession chain from the OEM catalogue.
  { id: "sample-link-brk-1-3", a: "sample-pn-brk-0001", b: "sample-pn-brk-0003", type: "SUPERSEDED_BY", source: "OEM_CATALOGUE", status: "APPROVED" },
  // Mechanic-confirmed equivalent further along the chain.
  { id: "sample-link-brk-3-4", a: "sample-pn-brk-0003", b: "sample-pn-brk-0004", type: "EXACT_EQUIVALENT", source: "MECHANIC_CONFIRMED", status: "APPROVED" },
  // Not safety-critical: brand cross-reference counts.
  { id: "sample-link-mir-1-2", a: "sample-pn-mir-0001", b: "sample-pn-mir-0002", type: "EXACT_EQUIVALENT", source: "BRAND_CROSS_REFERENCE", status: "APPROVED" },
  // Fits with modification: never traversed, always shows notes.
  {
    id: "sample-link-mir-1-3",
    a: "sample-pn-mir-0001",
    b: "sample-pn-mir-0003",
    type: "FITS_WITH_MODIFICATION",
    source: "ADMIN",
    status: "APPROVED",
    notes: "SAMPLE note: needs the longer mounting stem from the Roadster 200 kit.",
  },
  // Community suggestion awaiting review.
  { id: "sample-link-lgt-1-2", a: "sample-pn-lgt-0001", b: "sample-pn-lgt-0002", type: "EXACT_EQUIVALENT", source: "USER_SUBMITTED", status: "PENDING" },
  // Rejected suggestion.
  { id: "sample-link-mir-2-3", a: "sample-pn-mir-0002", b: "sample-pn-mir-0003", type: "EXACT_EQUIVALENT", source: "USER_SUBMITTED", status: "REJECTED" },
];

export const SAMPLE_PART_FITMENTS: { id: string; partNumberId: string; variantId: string; source: FitmentSource }[] = [
  { id: "sample-fit-brk-0001-street-std", partNumberId: "sample-pn-brk-0001", variantId: "sample-variant-street-150-std", source: "PART_NUMBER_MATCH" },
  { id: "sample-fit-brk-0001-street-disc", partNumberId: "sample-pn-brk-0001", variantId: "sample-variant-street-150-disc", source: "PART_NUMBER_MATCH" },
  { id: "sample-fit-brk-0003-roadster-std", partNumberId: "sample-pn-brk-0003", variantId: "sample-variant-roadster-200-std", source: "PART_NUMBER_MATCH" },
  { id: "sample-fit-mir-0001-roadster-std", partNumberId: "sample-pn-mir-0001", variantId: "sample-variant-roadster-200-std", source: "PART_NUMBER_MATCH" },
  { id: "sample-fit-mir-0001-roadster-abs", partNumberId: "sample-pn-mir-0001", variantId: "sample-variant-roadster-200-abs", source: "PART_NUMBER_MATCH" },
  { id: "sample-fit-exh-0001-street-std", partNumberId: "sample-pn-exh-0001", variantId: "sample-variant-street-150-std", source: "PART_NUMBER_MATCH" },
  { id: "sample-fit-lgt-0001-city-std", partNumberId: "sample-pn-lgt-0001", variantId: "sample-variant-city-125-std", source: "MECHANIC_CONFIRMED" },
  { id: "sample-fit-set-0001-city-conn", partNumberId: "sample-pn-set-0001", variantId: "sample-variant-city-125-conn", source: "PART_NUMBER_MATCH" },
  { id: "sample-fit-whl-0001-roadster-abs", partNumberId: "sample-pn-whl-0001", variantId: "sample-variant-roadster-200-abs", source: "PART_NUMBER_MATCH" },
];

/**
 * SAMPLE pincode geography (decision D-12). Codes 99990x are used so they are not
 * presented as real locations; district names and coordinates are fictional.
 */
export const SAMPLE_PINCODES = [
  { pincode: "999901", district: "Sample District North", state: "Sample State", lat: 12.9, lng: 77.5 },
  { pincode: "999902", district: "Sample District South", state: "Sample State", lat: 12.8, lng: 77.6 },
  { pincode: "999903", district: "Sample District East", state: "Sample State", lat: 13.0, lng: 77.8 },
  { pincode: "999904", district: "Sample District West", state: "Sample State", lat: 12.95, lng: 77.3 },
  { pincode: "999905", district: "Sample District Far", state: "Sample State", lat: 13.6, lng: 78.4 },
];
