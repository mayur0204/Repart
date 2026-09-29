import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * Static design-rule check (REPART_BRIEF.md §10 hard rules, PLAN.md §8.2 layer 1).
 * Fails on rounded corners, decorative shadows, gradients, blur, all-caps, tracking,
 * monospace, hover lift, emoji, middle-dot meta strings and arrows appended to text.
 */

export type Violation = { file: string; line: number; rule: string; match: string };

type Rule = { id: string; pattern: RegExp; message: string };

// Class tokens in TS/TSX (comments are stripped before matching).
const TOKEN = String.raw`(?<=^|[\s"'\`{(:!])`;
const END = String.raw`(?=$|[\s"'\`})])`;

const codeRules: Rule[] = [
  { id: "no-rounded", pattern: new RegExp(`${TOKEN}(?:[a-z0-9-]+:)*!?rounded(?:-[\\w\\[\\]/.%-]+)?${END}`, "g"), message: "rounded corners are not allowed" },
  { id: "no-radius-style", pattern: /borderRadius\s*:(?!\s*(?:0\b|["'`]0(?:px)?["'`]))[^,}\n]+/g, message: "non-zero borderRadius in style" },
  { id: "no-shadow", pattern: new RegExp(`${TOKEN}(?:[a-z0-9-]+:)*!?(?:shadow(?!-float${END})(?:-[\\w\\[\\]/.%-]+)?|drop-shadow(?:-[\\w-]+)?|inset-shadow(?:-[\\w-]+)?)${END}`, "g"), message: "only shadow-float (floating layers) is allowed" },
  { id: "no-gradient", pattern: new RegExp(`${TOKEN}(?:[a-z0-9-]+:)*(?:(?:bg-gradient|bg-linear|bg-radial|bg-conic)-[\\w\\[\\]/.%-]+|(?:from|via|to)-(?:ink|steel|rule|page|surface|action|fit|caution|danger|transparent|current|white|black|\\[)[\\w\\[\\]/.%#-]*)${END}`, "g"), message: "gradients are not allowed" },
  { id: "no-blur", pattern: new RegExp(`${TOKEN}(?:[a-z0-9-]+:)*(?:backdrop-blur(?:-[\\w-]+)?|blur-[\\w\\[\\]-]+)${END}`, "g"), message: "blur / glassmorphism is not allowed" },
  { id: "no-uppercase", pattern: new RegExp(`${TOKEN}(?:[a-z0-9-]+:)*uppercase${END}`, "g"), message: "ALL-CAPS labels are not allowed" },
  { id: "no-tracking", pattern: new RegExp(`${TOKEN}(?:[a-z0-9-]+:)*tracking-[\\w\\[\\]/.%-]+${END}`, "g"), message: "tracked-out text is not allowed (use part-no for part numbers)" },
  { id: "no-mono", pattern: /font-mono\b|monospace/g, message: "monospace fonts are not allowed" },
  { id: "no-hover-lift", pattern: /hover:-?translate-y-[\w\[\]]+|hover:scale-[\w\[\]]+/g, message: "hover lift animations are not allowed" },
  { id: "no-emoji", pattern: /\p{Extended_Pictographic}/gu, message: "emoji are not allowed" },
  { id: "no-middle-dot", pattern: /\s·\s/g, message: "meta strings joined with middle dots are not allowed" },
  { id: "no-trailing-arrow", pattern: /(?:→|->|›|»)\s*(?:<\/|["'`]\s*[,)}])/g, message: "arrows appended to button or link text are not allowed" },
];

const cssRules: Rule[] = [
  { id: "no-radius-css", pattern: /border(?:-[a-z]+)*-radius\s*:(?!\s*0(?:px|rem|em|%)?\s*(?:!important)?\s*[;}])[^;}]+/g, message: "non-zero border-radius" },
  { id: "no-radius-token", pattern: /--radius[\w-]*\s*:(?!\s*(?:0|initial)\s*[;}])[^;}]+/g, message: "radius tokens must be 0" },
  { id: "no-gradient-css", pattern: /(?:linear|radial|conic)-gradient\(/g, message: "gradients are not allowed" },
  { id: "no-blur-css", pattern: /backdrop-filter|filter\s*:\s*blur/g, message: "blur / glassmorphism is not allowed" },
  { id: "no-uppercase-css", pattern: /text-transform\s*:\s*uppercase/g, message: "ALL-CAPS text is not allowed" },
  { id: "no-mono-css", pattern: /monospace/g, message: "monospace fonts are not allowed" },
  { id: "no-letter-spacing-css", pattern: /letter-spacing\s*:/g, message: "letter-spacing only in the part-no utility" },
  { id: "no-box-shadow-css", pattern: /box-shadow\s*:/g, message: "use the shadow-float token only" },
  { id: "no-shadow-token", pattern: /--(?:inset-|drop-|text-)?shadow-(?!float\b|\*)[\w-]+\s*:/g, message: "only --shadow-float may be defined" },
];

function stripComments(source: string, css: boolean): string {
  // Replace comments with spaces of equal length so line numbers stay correct.
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let out = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!css) out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(p1.length)));
  return out;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function checkSource(file: string, source: string): Violation[] {
  const css = extname(file) === ".css";
  let text = stripComments(source, css);
  if (css) {
    // letter-spacing is allowed only inside the part-no utility.
    text = text.replace(/@utility\s+part-no\s*\{[^}]*\}/g, (m) => m.replace(/[^\n]/g, " "));
  }
  const rules = css ? cssRules : codeRules;
  const violations: Violation[] = [];
  for (const rule of rules) {
    for (const m of text.matchAll(rule.pattern)) {
      violations.push({ file, line: lineOf(text, m.index ?? 0), rule: `${rule.id}: ${rule.message}`, match: m[0].trim() });
    }
  }
  return violations;
}

const SCAN_DIRS = ["app", "src"];
const SKIP = new Set(["node_modules", ".next", "generated"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(extname(name))) out.push(full);
  }
}

export function checkRepo(root: string): Violation[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(join(root, dir), files);
  return files.flatMap((full) =>
    checkSource(relative(root, full).split(sep).join("/"), readFileSync(full, "utf8")),
  );
}
