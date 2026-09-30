import type { PrismaClient } from "../../src/generated/prisma/client";
import { DEFAULT_SETTINGS, settingsSchema } from "../../src/server/services/settings/schema";

/**
 * Inactive settings snapshots with a fixed audit percentage. Orders store the settings version they were priced
 * with, and audit selection (M10) is a hash of the order id; pointing a test order at one of these makes the
 * audit decision deterministic without touching the active settings (which every test file re-seeds).
 */
export const NO_AUDIT_VERSION = 9000;
export const ALWAYS_AUDIT_VERSION = 9001;

async function snapshot(db: PrismaClient, version: number, auditPercent: number) {
  const data = settingsSchema.parse({ ...DEFAULT_SETTINGS, inspections: { ...DEFAULT_SETTINGS.inspections, auditPercent } });
  await db.settingsVersion.upsert({ where: { version }, create: { version, data, isActive: false, note: `test fixture: auditPercent ${auditPercent}` }, update: { data } });
  return version;
}

export const noAuditVersion = (db: PrismaClient) => snapshot(db, NO_AUDIT_VERSION, 0);
export const alwaysAuditVersion = (db: PrismaClient) => snapshot(db, ALWAYS_AUDIT_VERSION, 100);

/** Call in afterAll: the settings tests number new versions after the highest existing one. */
export async function removeSettingsFixtures(db: PrismaClient) {
  await db.settingsVersion.deleteMany({ where: { version: { in: [NO_AUDIT_VERSION, ALWAYS_AUDIT_VERSION] } } });
}
