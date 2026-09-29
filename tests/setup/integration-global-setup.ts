import "dotenv/config";
import { resetTestDatabase } from "../../scripts/test-db-reset";
import { assertLocalTestDatabase } from "./assert-test-db";

/** Runs once before the integration project: guard, recreate schema, apply migrations. */
export default async function setup(): Promise<void> {
  assertLocalTestDatabase(process.env.TEST_DATABASE_URL);
  await resetTestDatabase();
}
