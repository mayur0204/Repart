import "server-only";
import pino from "pino";

/**
 * JSON logger (PLAN.md §1.2 "Logging"). Secrets, OTPs, bank fields and phone numbers
 * are redacted wherever they appear as keys, including one level of nesting.
 */
export const REDACT_KEYS = [
  "password", "secret", "token", "otp", "code", "phone", "authorization", "cookie",
  "accountNumber", "ifsc", "upi", "apiKey", "serviceRoleKey",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: [...REDACT_KEYS, ...REDACT_KEYS.map((k) => `*.${k}`)], censor: "[redacted]" },
});
