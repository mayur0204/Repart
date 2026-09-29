import "server-only";
import type { ActorType, Prisma, PrismaClient } from "@/generated/prisma/client";
import { recordAudit } from "../audit/audit";
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "./schema";

/**
 * Versioned settings (PLAN.md §6.5). Versions are immutable once written: editing creates a
 * new inactive version, and activating one is audited with a before/after diff.
 * The active version number is recorded on orders and risk assessments as `ruleSetVersion`.
 */

type Db = Pick<PrismaClient, "$transaction" | "settingsVersion">;
type Actor = { type: ActorType; id?: string | null };

export type SettingsSnapshot = { version: number; settings: Settings };

export class SettingsError extends Error {}

const toJson = (s: Settings) => s as unknown as Prisma.InputJsonValue;

function parseStored(version: number, data: unknown): Settings {
  const result = settingsSchema.safeParse(data);
  if (!result.success) throw new SettingsError(`settings version ${version} is invalid: ${result.error.issues[0]?.message}`);
  return result.data;
}

/** The active version. Throws if none exists, since nothing that depends on settings can run safely without one. */
export async function getActiveSettings(db: Pick<PrismaClient, "settingsVersion">): Promise<SettingsSnapshot> {
  const row = await db.settingsVersion.findFirst({ where: { isActive: true } });
  if (!row) throw new SettingsError("no active settings version; run the seed or ensureDefaultSettings()");
  return { version: row.version, settings: parseStored(row.version, row.data) };
}

/** A specific version, e.g. the one an order was priced under. */
export async function getSettingsVersion(db: Pick<PrismaClient, "settingsVersion">, version: number): Promise<SettingsSnapshot> {
  const row = await db.settingsVersion.findUnique({ where: { version } });
  if (!row) throw new SettingsError(`settings version ${version} does not exist`);
  return { version, settings: parseStored(version, row.data) };
}

export async function listSettingsVersions(db: Pick<PrismaClient, "settingsVersion">) {
  return db.settingsVersion.findMany({
    orderBy: { version: "desc" },
    select: { version: true, isActive: true, note: true, createdById: true, createdAt: true },
  });
}

/** Creates the next version, inactive. Invalid data is rejected before anything is written. */
export async function createSettingsVersion(
  db: Db,
  input: { data: unknown; note?: string; actor: Actor; requestId?: string },
): Promise<SettingsSnapshot> {
  const settings = settingsSchema.parse(input.data);
  return db.$transaction(async (tx) => {
    const latest = await tx.settingsVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    const version = (latest?.version ?? 0) + 1;
    await tx.settingsVersion.create({
      data: { version, data: toJson(settings), isActive: false, note: input.note ?? null, createdById: input.actor.id ?? null },
    });
    await recordAudit(tx, {
      actor: input.actor,
      action: "settings.version_created",
      entity: { type: "SettingsVersion", id: String(version) },
      after: { version, note: input.note ?? null },
      requestId: input.requestId,
    });
    return { version, settings };
  });
}

export type SettingsChange = { path: string; before: unknown; after: unknown };

/** Leaf-level differences between two settings objects, as dotted paths. Arrays compare as whole values. */
export function diffSettings(before: unknown, after: unknown, path = ""): SettingsChange[] {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffSettings(before[k], after[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, before, after }];
}

/**
 * Makes `version` the only active version. The partial unique index on isActive guarantees
 * at most one active row even under concurrent activations.
 */
export async function activateSettingsVersion(
  db: Db,
  input: { version: number; actor: Actor; requestId?: string },
): Promise<SettingsSnapshot> {
  return db.$transaction(async (tx) => {
    const target = await tx.settingsVersion.findUnique({ where: { version: input.version } });
    if (!target) throw new SettingsError(`settings version ${input.version} does not exist`);
    const settings = parseStored(target.version, target.data);
    if (target.isActive) return { version: target.version, settings };

    const current = await tx.settingsVersion.findFirst({ where: { isActive: true } });
    if (current) await tx.settingsVersion.update({ where: { id: current.id }, data: { isActive: false } });
    await tx.settingsVersion.update({ where: { id: target.id }, data: { isActive: true } });

    const changes = diffSettings(current?.data ?? {}, target.data);
    await recordAudit(tx, {
      actor: input.actor,
      action: "settings.activated",
      entity: { type: "SettingsVersion", id: String(target.version) },
      before: {
        activeVersion: current?.version ?? null,
        values: Object.fromEntries(changes.map((c) => [c.path, (c.before ?? null) as Prisma.InputJsonValue])),
      },
      after: {
        activeVersion: target.version,
        values: Object.fromEntries(changes.map((c) => [c.path, (c.after ?? null) as Prisma.InputJsonValue])),
      },
      requestId: input.requestId,
    });
    return { version: target.version, settings };
  });
}

/**
 * Bootstraps version 1 from DEFAULT_SETTINGS when the table is empty (e.g. a fresh environment
 * that was migrated but not seeded). Does nothing if any version already exists.
 */
export async function ensureDefaultSettings(db: Db): Promise<SettingsSnapshot> {
  return db.$transaction(async (tx) => {
    const active = await tx.settingsVersion.findFirst({ where: { isActive: true } });
    if (active) return { version: active.version, settings: parseStored(active.version, active.data) };
    if ((await tx.settingsVersion.count()) > 0) {
      throw new SettingsError("settings versions exist but none is active; activate one explicitly");
    }
    const settings = settingsSchema.parse(DEFAULT_SETTINGS);
    await tx.settingsVersion.create({ data: { version: 1, data: toJson(settings), isActive: true, note: "Initial defaults" } });
    await recordAudit(tx, {
      actor: { type: "SYSTEM" },
      action: "settings.activated",
      entity: { type: "SettingsVersion", id: "1" },
      after: { activeVersion: 1, source: "DEFAULT_SETTINGS" },
    });
    return { version: 1, settings };
  });
}
