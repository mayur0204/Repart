// Pre-commit guard (PLAN.md §1.2 "Secrets"): refuses to commit env files or key-like strings.
// Installed via `git config core.hooksPath .githooks`.
import { execFileSync } from "node:child_process";

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const problems = [];

for (const file of staged) {
  const base = file.split("/").pop() ?? file;
  if ((/^\.env(\..+)?$/i.test(base) || / ?\.env$/i.test(base)) && base !== ".env.example") problems.push(`${file}: env files must never be committed`);
  if (/\.(pem|key|p12)$/i.test(base)) problems.push(`${file}: key files must never be committed`);
}

const SECRET_PATTERNS = [
  [/postgres(?:ql)?:\/\/[^:\s"'`]+:(?!repart_local_only@|pw@|pass@|password@|w@|<)[^@\s"'`]{6,}@(?!127\.0\.0\.1|localhost)/, "database URL with a password"],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "JWT (e.g. a Supabase key)"],
  [/sb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/, "Supabase API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];

for (const file of staged) {
  if (file === "scripts/check-staged-secrets.mjs") continue;
  let content = "";
  try {
    content = execFileSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  } catch {
    continue; // binary or unreadable
  }
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(content)) problems.push(`${file}: looks like it contains a ${label}`);
  }
}

if (problems.length > 0) {
  console.error("Commit blocked by secret check:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
