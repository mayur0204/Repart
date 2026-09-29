import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;

beforeAll(async () => {
  db = testPrisma();
});
afterAll(async () => {
  await db.$disconnect();
});

describe("SAMPLE seed", () => {
  it("is idempotent", async () => {
    await seed(db);
    const counts = async () => ({
      users: await db.user.count(),
      listings: await db.listing.count(),
      orders: await db.order.count({ where: { isSample: true } }),
      partNumbers: await db.partNumber.count(),
      events: await db.orderEvent.count(),
    });
    const first = await counts();
    await seed(db);
    expect(await counts()).toEqual(first);
  });

  it("has sample listings in every listing status", async () => {
    const statuses = (await db.listing.groupBy({ by: ["status"], where: { isSample: true } })).map((g) => g.status).sort();
    expect(statuses).toEqual(
      ["CHANGES_REQUESTED", "DRAFT", "LIVE", "REJECTED", "RESERVED", "SCREENING", "SOLD", "SUBMITTED", "WITHDRAWN"].sort(),
    );
  });

  it("has sample users for every role", async () => {
    const users = await db.user.findMany({ where: { isSample: true } });
    const roles = new Set(users.flatMap((u) => u.roles));
    expect([...roles].sort()).toEqual(["ADMIN", "MECHANIC", "MEMBER"]);
  });

  it("marks every catalogue row as sample", async () => {
    expect(await db.vehicleMake.count({ where: { isSample: false } })).toBe(0);
    expect(await db.partNumber.count({ where: { isSample: false } })).toBe(0);
  });

  it("places the disputed sample order inside the 7-day auto-release warning window", async () => {
    const order = await db.order.findUniqueOrThrow({ where: { id: "sample-order-disputed" } });
    const daysLeft = (order.autoReleaseAt!.getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(0);
    expect(daysLeft).toBeLessThanOrEqual(7);
  });
});
