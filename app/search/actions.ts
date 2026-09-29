"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { publicSearch } from "@/server/services";
import { parseSearchQuery } from "@/server/services/search/search";

/** Save the current search (with alerts on) from the results page. Members only. */
export const saveSearch = defineAction({ input: z.object({ query: z.string().default("{}"), label: z.string().default("") }), access: "member" }, async (input, ctx) => {
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(input.query);
  } catch {
    raw = {};
  }
  await publicSearch.saveSearch(ctx.user.id, { query: parseSearchQuery(raw), label: input.label });
  revalidatePath("/garage/searches");
  return { ok: true, message: "Search saved. We'll let you know about new matches." };
});
