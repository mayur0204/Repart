/**
 * Listing helpers shared by the wizard (browser) and the server (REPART_BRIEF.md §9 "Selling").
 * Pure functions only, so both sides compute the same grade, warnings and limits.
 */

export const LISTING_STEPS = [
  { slug: "bike", label: "Bike" },
  { slug: "part", label: "Part" },
  { slug: "condition", label: "Condition" },
  { slug: "photos", label: "Photos" },
  { slug: "details", label: "Details" },
  { slug: "price", label: "Price and pickup" },
  { slug: "review", label: "Review" },
] as const;
export type StepSlug = (typeof LISTING_STEPS)[number]["slug"];
export const stepNumber = (slug: StepSlug) => LISTING_STEPS.findIndex((s) => s.slug === slug) + 1;

// ── condition grade (PLAN.md assumption A-17: score = 100 − Σ weights of bad answers) ──
export type ChecklistItem = { id: string; question: string; weight: number; badAnswer: "YES" | "NO"; blocksListing: boolean };
export type ChecklistAnswers = Record<string, "YES" | "NO">;
export type Grade = "LIKE_NEW" | "GOOD" | "FAIR" | "FOR_REPAIR";
export type GradeThresholds = { likeNewMin: number; goodMin: number; fairMin: number };

export function gradeFromChecklist(items: ChecklistItem[], answers: ChecklistAnswers, t: GradeThresholds) {
  const unanswered = items.filter((i) => answers[i.id] !== "YES" && answers[i.id] !== "NO").map((i) => i.id);
  const bad = items.filter((i) => answers[i.id] === i.badAnswer);
  const score = Math.max(0, 100 - bad.reduce((sum, i) => sum + i.weight, 0));
  const grade: Grade = score >= t.likeNewMin ? "LIKE_NEW" : score >= t.goodMin ? "GOOD" : score >= t.fairMin ? "FAIR" : "FOR_REPAIR";
  const blocking = bad.filter((i) => i.blocksListing).map((i) => i.question);
  return { score, grade, unanswered, blocking };
}

export const GRADE_TEXT: Record<Grade, { label: string; meaning: string }> = {
  LIKE_NEW: { label: "Like new", meaning: "No faults found in the checklist. Little or no visible wear." },
  GOOD: { label: "Good", meaning: "Works as it should, with some normal wear." },
  FAIR: { label: "Fair", meaning: "Works, with visible wear or minor faults described in the checklist." },
  FOR_REPAIR: { label: "For repair", meaning: "Needs repair before use. Sold for parts or restoration." },
};

// ── contact details typed into listings (inline warning; full masking arrives with messages in M7) ──
const CONTACT_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "phone number", pattern: /(?:\+?91[\s-]*)?(?:[6-9](?:[\s-]*\d){9})\b/ },
  { kind: "email address", pattern: /[\w.+-]+@[\w-]+\.[\w.]{2,}/i },
  { kind: "UPI id", pattern: /\b[\w.-]{2,}@(?:ok)?[a-z]{2,}\b/i },
  { kind: "messaging app", pattern: /\b(?:whats\s?app|telegram|call me|dm me)\b/i },
];

/** Kinds of contact detail found in text, e.g. ["phone number"]. */
export function detectContactDetails(text: string): string[] {
  return CONTACT_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.kind);
}

// ── photos ──
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_LISTING_PHOTOS = 12;

export function photoFileProblem(file: { type: string; size: number }): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) return "Use a JPEG, PNG or WebP photo.";
  if (file.size === 0) return "This file is empty. Choose the photo again.";
  if (file.size > MAX_PHOTO_BYTES) return "This photo is over 10 MB. Take it again at a lower resolution.";
  return null;
}

/** Detects the real image type from the first bytes (never trust the declared type). */
export function sniffImageType(bytes: Uint8Array): (typeof PHOTO_TYPES)[number] | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

// ── image quality maths on greyscale pixels (0–255, row-major) ──

/** Mean luminance. */
export function brightness(gray: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  return gray.length ? sum / gray.length : 0;
}

/** Variance of the 4-neighbour Laplacian: low values mean a blurry image. */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = gray[i - width]! + gray[i + width]! + gray[i - 1]! + gray[i + 1]! - 4 * gray[i]!;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * 64-bit DCT perceptual hash of a 32×32 greyscale image, as 16 hex characters.
 * Keeps the top-left 8×8 low frequencies (minus DC) and compares each to their median.
 */
export function perceptualHash(gray32: ArrayLike<number>): string {
  if (gray32.length !== 1024) throw new Error("perceptualHash expects a 32x32 greyscale image");
  const N = 32;
  const cos = Array.from({ length: 8 }, (_, u) => Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));
  const coeffs: number[] = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) s += gray32[y * N + x]! * cos[u]![y]! * cos[v]![x]!;
      coeffs.push(s);
    }
  }
  const ac = coeffs.slice(1);
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)]!;
  let bits = "";
  for (const c of coeffs) bits += c > median ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Plain-language on-device warnings, using the thresholds from the active settings. */
export function qualityWarnings(m: { brightness: number; blur: number }, t: { minBrightness: number; maxBrightness: number; blurThreshold: number }): string[] {
  const out: string[] = [];
  if (m.brightness < t.minBrightness) out.push("This photo looks too dark. Take it in daylight or turn on more lights.");
  if (m.brightness > t.maxBrightness) out.push("This photo looks too bright. Move out of direct sunlight or away from the flash.");
  if (m.blur < t.blurThreshold) out.push("This photo looks blurry. Hold the phone steady and tap the part to focus.");
  return out;
}
