import { describe, expect, it, vi } from "vitest";
import { runHealthChecks } from "@/server/health";
import { recordAudit, redactSnapshot } from "@/server/services/audit/audit";
import { enqueueOutbox, OUTBOX_MAX_ATTEMPTS, relayOutbox } from "@/server/services/outbox/outbox";
import { runJob } from "@/worker/handlers";

describe("recordAudit", () => {
  it("writes one row with sensitive fields redacted", async () => {
    const create = vi.fn().mockResolvedValue({});
    await recordAudit({ auditLog: { create } } as never, {
      actor: { type: "ADMIN", id: "admin1" },
      action: "user.role_granted",
      entity: { type: "User", id: "u1" },
      before: { roles: ["MEMBER"], phone: "+919876543210" },
      after: { roles: ["MEMBER", "MECHANIC"], nested: { otp: "000000" } },
    });
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ actorType: "ADMIN", actorId: "admin1", entityType: "User", entityId: "u1" });
    expect(data.before).toEqual({ roles: ["MEMBER"], phone: "[redacted]" });
    expect(data.after).toEqual({ roles: ["MEMBER", "MECHANIC"], nested: { otp: "[redacted]" } });
  });

  it("rejects non-dotted action names", async () => {
    const tx = { auditLog: { create: vi.fn() } } as never;
    await expect(recordAudit(tx, { actor: { type: "SYSTEM" }, action: "Did Stuff", entity: { type: "X", id: "1" } })).rejects.toThrow(/dotted/);
  });

  it("leaves primitives and null alone", () => {
    expect(redactSnapshot(null)).toBeUndefined();
    expect(redactSnapshot(5)).toBe(5);
  });
});

describe("enqueueOutbox", () => {
  it("validates the payload against the job schema before writing", async () => {
    const create = vi.fn().mockResolvedValue({ id: "job1" });
    const tx = { outboxJob: { create } } as never;
    expect(await enqueueOutbox(tx, { queue: "system", name: "ping", payload: { note: "hi" } })).toBe("job1");
    await expect(
      enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId: "", channel: "SMS", type: "t", title: "t", body: "b" } }),
    ).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("relayOutbox", () => {
  const row = (id: string, attempts = 0, runAt = new Date(0)) => ({
    id, queue: "system", name: "ping", payload: {}, runAt, status: "PENDING", attempts, dispatchedAt: null, createdAt: new Date(0),
  });

  function fakeDb(rows: ReturnType<typeof row>[]) {
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    return {
      updates,
      db: {
        outboxJob: {
          findMany: vi.fn().mockResolvedValue(rows),
          updateMany: vi.fn(async ({ where, data }) => {
            updates.push({ id: where.id, data });
            return { count: 1 };
          }),
        },
      } as never,
    };
  }

  it("dispatches pending rows with a delay for future runAt and marks them dispatched", async () => {
    const now = new Date(10_000);
    const { db, updates } = fakeDb([row("a"), row("b", 0, new Date(15_000))]);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    expect(await relayOutbox(db, dispatch, { now })).toEqual({ dispatched: 2, failed: 0 });
    expect(dispatch.mock.calls.map((c) => c[1])).toEqual([0, 5_000]);
    expect(updates.every((u) => u.data.status === "DISPATCHED")).toBe(true);
  });

  it("keeps failed rows pending until the attempt limit, then marks them failed", async () => {
    const { db, updates } = fakeDb([row("a", 0), row("b", OUTBOX_MAX_ATTEMPTS - 1)]);
    const dispatch = vi.fn().mockRejectedValue(new Error("redis down"));
    expect(await relayOutbox(db, dispatch)).toEqual({ dispatched: 0, failed: 2 });
    expect(updates).toEqual([
      { id: "a", data: { attempts: 1, status: "PENDING" } },
      { id: "b", data: { attempts: OUTBOX_MAX_ATTEMPTS, status: "FAILED" } },
    ]);
  });
});

describe("worker runJob", () => {
  it("rejects unknown jobs and invalid payloads", async () => {
    await expect(runJob("system", "nope", {})).rejects.toThrow(/no handler/);
    await expect(runJob("system", "ping", { note: 5 })).rejects.toThrow();
    await expect(runJob("system", "ping", {})).resolves.toBeUndefined();
  });
});

describe("runHealthChecks", () => {
  it("reports up/down only and routes errors to the callback", async () => {
    const onError = vi.fn();
    const report = await runHealthChecks(
      {
        database: async () => 1,
        redis: async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:6379");
        },
        storage: () => new Promise(() => {}),
      },
      onError,
      50,
    );
    expect(report).toEqual({ status: "degraded", checks: { database: "up", redis: "down", storage: "down" } });
    expect(JSON.stringify(report)).not.toContain("ECONNREFUSED");
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
