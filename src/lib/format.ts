/**
 * Display formatting (REPART_BRIEF.md §10 "Formatting", PLAN.md §8.1).
 * Money is stored as integer paise; dates render as "28 Sep 2026"; distances in km.
 */

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const rupeesWithPaise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });

/** ₹75,000 / ₹1,25,000. Whole rupees are shown without decimals; anything with paise shows two places. */
export function formatPrice(paise: number): string {
  if (!Number.isInteger(paise)) throw new Error(`formatPrice expects integer paise, got ${paise}`);
  return paise % 100 === 0 ? rupees.format(paise / 100) : rupeesWithPaise.format(paise / 100);
}

const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** 28 Sep 2026 (India time). */
export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  // en-IN gives "28 Sept 2026" in newer ICU; the brief specifies three-letter months.
  return dateFormat.format(d).replace("Sept", "Sep");
}

const km = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

/** 12 km / 1,250 km / 0.8 km */
export function formatKm(kilometres: number): string {
  return `${km.format(kilometres)} km`;
}
