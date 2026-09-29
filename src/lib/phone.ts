/**
 * Indian mobile numbers, stored as E.164 (+91XXXXXXXXXX).
 * Accepts 10 digits with optional +91 / 91 / 0 prefix and spaces or dashes.
 * Real mobiles start with 6–9. Seeded SAMPLE users use +91 55555xxxxx, which is not
 * a real mobile range; those are accepted only when `allowSample` is set (never in production).
 */
export function normalizeIndianPhone(input: string, opts: { allowSample?: boolean } = {}): string | null {
  const digits = input.replace(/[\s()-]/g, "").replace(/^\+?91(?=\d{10}$)/, "").replace(/^0(?=\d{10}$)/, "");
  if (!/^\d{10}$/.test(digits)) return null;
  if (/^[6-9]/.test(digits)) return `+91${digits}`;
  if (opts.allowSample && digits.startsWith("55555")) return `+91${digits}`;
  return null;
}

/** +91 98••••••10 style mask for display and logs. */
export function maskPhone(e164: string): string {
  const national = e164.replace(/^\+91/, "");
  return `+91 ${national.slice(0, 2)}${"•".repeat(Math.max(0, national.length - 4))}${national.slice(-2)}`;
}
