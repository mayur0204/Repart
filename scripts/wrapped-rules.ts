import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * "Every action is wrapped" rule (PLAN.md §1.2 RBAC). In app/**:
 *  - a file starting with "use server" may only export `const X = defineAction(...)`;
 *  - "use server" may not appear anywhere else (no inline server actions);
 *  - route.ts may only export HTTP handlers built with defineRoute, plus route segment config.
 */
export type WrapViolation = { file: string; line: number; message: string };

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const ROUTE_CONFIG = new Set(["dynamic", "revalidate", "runtime", "fetchCache", "preferredRegion", "maxDuration", "dynamicParams"]);

function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(p1.length)));
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

export function checkWrapped(file: string, source: string): WrapViolation[] {
  const text = stripComments(source);
  const out: WrapViolation[] = [];
  const directive = /^\s*["']use server["'];?/;
  const isServerFile = directive.test(text);
  const isRoute = /(^|[\\/])route\.tsx?$/.test(file);

  // Inline "use server" anywhere other than the top of the file.
  const body = isServerFile ? text.replace(directive, (m) => " ".repeat(m.length)) : text;
  for (const m of body.matchAll(/["']use server["']/g)) {
    out.push({ file, line: lineOf(body, m.index ?? 0), message: 'inline "use server" is not allowed; put the action in an actions.ts file built with defineAction' });
  }

  if (!isServerFile && !isRoute) return out;

  for (const m of text.matchAll(/^\s*export\s+(default\s+)?(async\s+)?(function|const|let|var|class|\{|\*)\s*([A-Za-z_$][\w$]*)?/gm)) {
    const line = lineOf(text, m.index ?? 0);
    const [, isDefault, , kind, name] = m;
    if (isDefault || kind === "{" || kind === "*") {
      out.push({ file, line, message: "default, re-exports and export lists are not allowed here; export each handler as a const" });
      continue;
    }
    if (kind !== "const") {
      out.push({ file, line, message: `export ${kind} ${name ?? ""} must be \`export const ${name ?? "X"} = ${isRoute ? "defineRoute" : "defineAction"}(...)\`` });
      continue;
    }
    const rest = text.slice((m.index ?? 0) + m[0].length);
    if (isRoute && name && ROUTE_CONFIG.has(name)) continue;
    const wrapper = isRoute ? "defineRoute" : "defineAction";
    if (!new RegExp(`^\\s*(?::[^=]+)?=\\s*${wrapper}\\(`).test(rest)) {
      out.push({ file, line, message: `${name} must be built with ${wrapper}(...)` });
    } else if (isRoute && name && !HTTP_METHODS.has(name)) {
      out.push({ file, line, message: `${name} is not an HTTP method export` });
    }
  }
  return out;
}

export function checkAppDir(root: string): WrapViolation[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) files.push(full);
    }
  };
  walk(join(root, "app"));
  return files.flatMap((f) => checkWrapped(relative(root, f).split(sep).join("/"), readFileSync(f, "utf8")));
}
