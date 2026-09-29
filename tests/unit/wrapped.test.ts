import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkAppDir, checkWrapped } from "../../scripts/wrapped-rules";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("every server action and route handler is wrapped (PLAN.md §1.2)", () => {
  it("app/** has no unwrapped actions or route handlers", () => {
    expect(checkAppDir(root)).toEqual([]);
  });

  it("sanity: the checker flags an unwrapped export", () => {
    const bad = checkWrapped("app/x/actions.ts", '"use server";\nexport async function leak() {}\n');
    expect(bad).toHaveLength(1);
  });
});

describe("checkWrapped fixtures", () => {
  const action = (body: string) => checkWrapped("app/x/actions.ts", `"use server";\n${body}`);
  const route = (body: string) => checkWrapped("app/api/x/route.ts", body);

  it("accepts defineAction exports in use-server files", () => {
    expect(action('export const save = defineAction({ input, access: "member" }, async () => {});')).toEqual([]);
  });

  it("rejects plain async functions, other consts, defaults and re-exports", () => {
    expect(action("export async function save() {}")[0]?.message).toMatch(/defineAction/);
    expect(action("export const save = async () => {};")[0]?.message).toMatch(/defineAction/);
    expect(action("export default async function save() {}")).toHaveLength(1);
    expect(action('export { save } from "./other";')).toHaveLength(1);
  });

  it("rejects inline use-server directives anywhere in app/**", () => {
    const page = checkWrapped("app/x/page.tsx", 'export default function P() { async function a() { "use server"; } return null; }');
    expect(page[0]?.message).toMatch(/inline/);
  });

  it("accepts defineRoute handlers and segment config in route files", () => {
    expect(route('export const dynamic = "force-dynamic";\nexport const GET = defineRoute({ access: "public" }, async () => new Response());')).toEqual([]);
  });

  it("rejects unwrapped route handlers", () => {
    expect(route("export async function GET() { return new Response(); }")[0]?.message).toMatch(/defineRoute/);
    expect(route("export const POST = async () => new Response();")[0]?.message).toMatch(/defineRoute/);
  });

  it("ignores exports mentioned in comments", () => {
    expect(action("// export async function old() {}\nexport const ok = defineAction({ input, access: \"public\" }, async () => {});")).toEqual([]);
  });
});
