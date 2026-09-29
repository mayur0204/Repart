import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { assertLocalTestDatabase } from "./assert-test-db";

/** Prisma client bound to the local test database only. */
export function testPrisma(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL;
  assertLocalTestDatabase(url);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Raw pg client for catalogue queries (pg_tables, pg_policies, role checks). */
export async function testPg(): Promise<pg.Client> {
  const url = process.env.TEST_DATABASE_URL;
  assertLocalTestDatabase(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
