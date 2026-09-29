import "server-only";
import { findExposedSecrets, parseServerEnv, type ServerEnv } from "./env-schema";

let cached: ServerEnv | undefined;

/** Validated server environment. Throws on first access if anything is missing or malformed. */
export function env(): ServerEnv {
  if (!cached) {
    const exposed = findExposedSecrets(process.env);
    if (exposed.length > 0) {
      throw new Error(`Secret-like variables must not use the NEXT_PUBLIC_ prefix: ${exposed.join(", ")}`);
    }
    cached = parseServerEnv(process.env);
  }
  return cached;
}
