/**
 * DEVELOPMENT ONLY: links a seeded SAMPLE user to a Supabase Auth login, so demo accounts keep their seeded roles.
 *
 *   1. Supabase Dashboard (DEVELOPMENT project) → Authentication → Users → Add user → Create new user,
 *      with an email and password of your choice and "Auto Confirm User" ticked.
 *   2. npx tsx scripts/link-sample-auth-user.ts --target=dev --user=sample-user-admin --email=<that email>
 *
 * Passwords never pass through this script. Roles are not changed: the RePart User row stays authoritative.
 * Refuses NODE_ENV=production (same guard as the seed) and anything that isn't an isSample user.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { createClient } from "@supabase/supabase-js";
import { PrismaClient } from "../src/generated/prisma/client";
import { resolveSeedTarget } from "../prisma/seed/seed";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]?.trim();

async function main() {
  const { url } = resolveSeedTarget(process.argv.slice(2), process.env);
  const userId = arg("user");
  const email = arg("email")?.toLowerCase();
  if (!userId || !email) throw new Error("Pass --user=<sample user id, e.g. sample-user-admin> and --email=<Supabase Auth email>.");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side only).");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 }); // ponytail: one page, fine for a dev project
  if (error) throw new Error(`Couldn't list Supabase Auth users: ${error.message}`);
  const authUser = data.users.find((u) => u.email?.toLowerCase() === email);
  if (!authUser) throw new Error(`No Supabase Auth user with email ${email}. Create it in the Dashboard first (see the top of this file).`);

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { isSample: true, roles: true } });
    if (!user?.isSample) throw new Error(`${userId} isn't a SAMPLE user. Only seeded sample users can be linked this way.`);
    const other = await db.user.findUnique({ where: { supabaseAuthUserId: authUser.id }, select: { id: true } });
    if (other && other.id !== userId) throw new Error(`That login is already linked to ${other.id}.`);
    await db.user.update({ where: { id: userId }, data: { supabaseAuthUserId: authUser.id, email } });
    console.log(`Linked ${email} → ${userId} (roles: ${user.roles.join(", ")}).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
