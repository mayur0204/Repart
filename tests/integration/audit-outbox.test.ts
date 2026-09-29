import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { recordAudit } from "../../src/server/services/audit/audit";
import { enqueueOutbox, relayOutbox } from "../../src/server/services/outbox/outbox";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;

beforeAll(() => {
  db = testPrisma();
});
afterAll(async () => {
  await db.$disconnect();
});

describe("audit log (PLAN.md §1.2 audit coverage)", () => {
  it("is written inside the caller's transaction and rolls back with it", async () => {
    const entityId = `rollback-${Date.now()}`;
    await expect(
      db.$transaction(async (tx) => {
        await recordAudit(tx, { actor: { type: "SYSTEM" }, action: "test.rolled_back", entity: { type: "Test", id: entityId } });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.auditLog.count({ where: { entityId } })).toBe(0);
  });

  it("is append-only: UPDATE and DELETE are rejected by the database", async () => {
    const entityId = `append-only-${Date.now()}`;
    await db.$transaction((tx) =>
      recordAudit(tx, { actor: { type: "ADMIN", id: "a1" }, action: "test.created", entity: { type: "Test", id: entityId }, after: { ok: true } }),
    );
    const row = await db.auditLog.findFirstOrThrow({ where: { entityId } });
    await expect(db.auditLog.update({ where: { id: row.id }, data: { action: "test.tampered" } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
});

describe("outbox (PLAN.md §1.2 side effects)", () => {
  it("commits jobs with the business transaction and relays each exactly once", async () => {
    const note = `relay-${Date.now()}`;
    const id = await db.$transaction((tx) => enqueueOutbox(tx, { queue: "system", name: "ping", payload: { note } }));
    await expect(
      db.$transaction(async (tx) => {
        await enqueueOutbox(tx, { queue: "system", name: "ping", payload: { note: `${note}-rolled-back` } });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    const dispatched: string[] = [];
    const dispatch = async (job: { id: string }) => {
      dispatched.push(job.id);
    };
    await relayOutbox(db, dispatch, { limit: 1000 });
    await relayOutbox(db, dispatch, { limit: 1000 });

    expect(dispatched.filter((d) => d === id)).toHaveLength(1);
    expect(await db.outboxJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DISPATCHED", attempts: 1 });
    expect(await db.outboxJob.count({ where: { payload: { equals: { note: `${note}-rolled-back` } } } })).toBe(0);
  });
});
