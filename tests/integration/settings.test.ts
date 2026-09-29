import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { DEFAULT_SETTINGS } from "../../src/server/services/settings/schema";
import {
  activateSettingsVersion,
  createSettingsVersion,
  ensureDefaultSettings,
  getActiveSettings,
  getSettingsVersion,
  listSettingsVersions,
  SettingsError,
} from "../../src/server/services/settings/settings";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const admin = { type: "ADMIN" as const, id: "sample-user-admin" };

/** Put settings back to the seeded state (v1 only, active) so other suites are unaffected. */
async function restoreSeededSettings() {
  await db.settingsVersion.updateMany({ where: { isActive: true }, data: { isActive: false } });
  await db.settingsVersion.deleteMany({ where: { version: { gt: 1 } } });
  await seed(db);
}

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
afterAll(async () => {
  await restoreSeededSettings();
  await db.$disconnect();
});

describe("settings service (PLAN.md §6.5)", () => {
  it("the seeded default version 1 is active and valid", async () => {
    const active = await getActiveSettings(db);
    expect(active.version).toBe(1);
    expect(active.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("creating a version stores it inactive and audits it", async () => {
    const data = structuredClone(DEFAULT_SETTINGS);
    data.inspections.auditPercent = 8;
    const created = await createSettingsVersion(db, { data, note: "Raise audit rate", actor: admin });

    expect(created.version).toBe(2);
    expect((await getActiveSettings(db)).version).toBe(1);
    expect((await listSettingsVersions(db)).map((v) => [v.version, v.isActive])).toEqual([
      [2, false],
      [1, true],
    ]);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "settings.version_created", entityId: "2" }, orderBy: { createdAt: "desc" } });
    expect(audit).toMatchObject({ actorType: "ADMIN", actorId: admin.id });
  });

  it("rejects invalid data without writing a version", async () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    bad.risk.adminReviewThreshold = 10;
    await expect(createSettingsVersion(db, { data: bad, actor: admin })).rejects.toThrow();
    expect(await db.settingsVersion.count()).toBe(2);
  });

  it("activation switches the single active version and audits a before/after diff", async () => {
    const activated = await activateSettingsVersion(db, { version: 2, actor: admin, requestId: "req-1" });
    expect(activated.settings.inspections.auditPercent).toBe(8);
    expect((await getActiveSettings(db)).version).toBe(2);
    expect(await db.settingsVersion.count({ where: { isActive: true } })).toBe(1);

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "settings.activated", entityId: "2" }, orderBy: { createdAt: "desc" } });
    expect(audit.before).toEqual({ activeVersion: 1, values: { "inspections.auditPercent": 5 } });
    expect(audit.after).toEqual({ activeVersion: 2, values: { "inspections.auditPercent": 8 } });
    expect(audit.requestId).toBe("req-1");

    // Older versions stay readable, e.g. for orders priced under them.
    expect((await getSettingsVersion(db, 1)).settings.inspections.auditPercent).toBe(5);
  });

  it("re-activating the active version is a no-op and unknown versions are refused", async () => {
    const before = await db.auditLog.count({ where: { action: "settings.activated" } });
    await activateSettingsVersion(db, { version: 2, actor: admin });
    expect(await db.auditLog.count({ where: { action: "settings.activated" } })).toBe(before);
    await expect(activateSettingsVersion(db, { version: 99, actor: admin })).rejects.toBeInstanceOf(SettingsError);
    await expect(getSettingsVersion(db, 99)).rejects.toBeInstanceOf(SettingsError);
  });

  it("the database refuses a second active version", async () => {
    await expect(db.settingsVersion.update({ where: { version: 1 }, data: { isActive: true } })).rejects.toThrow();
  });

  it("ensureDefaultSettings keeps an existing active version and bootstraps an empty table", async () => {
    expect((await ensureDefaultSettings(db)).version).toBe(2);

    await db.settingsVersion.deleteMany({});
    await expect(getActiveSettings(db)).rejects.toBeInstanceOf(SettingsError);
    const boot = await ensureDefaultSettings(db);
    expect(boot).toEqual({ version: 1, settings: DEFAULT_SETTINGS });
    expect((await getActiveSettings(db)).version).toBe(1);

    await db.settingsVersion.update({ where: { version: 1 }, data: { isActive: false } });
    await expect(ensureDefaultSettings(db)).rejects.toThrow(/none is active/);
  });
});
