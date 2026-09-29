import { checkRepo } from "./design-rules";

const violations = checkRepo(process.cwd());

if (violations.length > 0) {
  for (const v of violations) console.error(`${v.file}:${v.line}  ${v.rule}  (${v.match})`);
  console.error(`\n${violations.length} design-rule violation(s).`);
  process.exit(1);
}
console.log("Design rules: no violations.");
