import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 used by the mock providers to sign and verify their fake webhooks. */
export function signBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySignature(secret: string, rawBody: string, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signBody(secret, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
