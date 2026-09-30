import { randomBytes } from "node:crypto";
import { one, waitForRow, withDb } from "./db";

/**
 * Fixture data for journeys that consume a listing: a copy of a seeded SAMPLE listing with a new id, so each run on
 * each width buys its own part. Nothing here is real-world data.
 */
export async function copyListing(fromId: string): Promise<{ id: string; title: string }> {
  const id = `e2e-${randomBytes(6).toString("hex")}`;
  const title = `SAMPLE e2e part ${id.slice(4)}`;
  await withDb(async (c) => {
    await c.query(`CREATE TEMP TABLE listing_copy AS SELECT * FROM "Listing" WHERE id = $1`, [fromId]);
    await c.query(`UPDATE listing_copy SET id = $1, title = $2, status = 'LIVE', version = 0, "createdAt" = now(), "updatedAt" = now()`, [id, title]);
    await c.query(`INSERT INTO "Listing" SELECT * FROM listing_copy`);
    await c.query(`DROP TABLE listing_copy`);
    // Keep the copy's fit data the same as the original's.
    await c.query(
      `INSERT INTO "Fitment" (id, "listingId", "variantId", source, verdict, "isSample") SELECT 'e2e-' || md5(random()::text), $1, "variantId", source, verdict, true FROM "Fitment" WHERE "listingId" = $2`,
      [id, fromId],
    );
  });
  return { id, title };
}

export const orderFor = (listingId: string) =>
  waitForRow<{ id: string; totalPaise: number; state: string }>(`SELECT id, "totalPaise", state FROM "Order" WHERE "listingId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [listingId]);

export const orderState = async (orderId: string) => (await one<{ state: string }>(`SELECT state FROM "Order" WHERE id = $1`, [orderId]))?.state;

export async function waitForOrderState(orderId: string, state: string, timeoutMs = 30_000): Promise<void> {
  await waitForRow(`SELECT 1 FROM "Order" WHERE id = $1 AND state = $2`, [orderId, state], timeoutMs);
}
