import "server-only";
import { randomUUID } from "node:crypto";
import type { FitmentSource, FitmentVerdict, ImportKind, InterchangeSource, InterchangeType, Prisma, PrismaClient } from "@/generated/prisma/client";
import { csvToRecords, CsvParseError } from "@/lib/csv";
import { normalizePartNumber } from "@/lib/part-number";
import { SLUG_PATTERN, slugify } from "@/lib/slug";
import type { StorageProvider } from "../../adapters/storage/types";
import { NotFoundError, UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";
import { canonicalPair, wouldCreateSupersessionCycle } from "../interchange/graph";

/**
 * Catalogue CSV import (PLAN.md §4.8, M3): upload → validate (dry run, nothing written to the
 * catalogue) → report → apply. Apply re-reads the stored file and re-validates against the
 * current catalogue inside one transaction, so a stale report can never be applied.
 * Rows are upserts keyed by natural keys; nothing is deleted.
 */
type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = { userId: string; requestId?: string };

export const MAX_IMPORT_BYTES = 1_000_000;
export const MAX_IMPORT_ROWS = 5_000;

export const IMPORT_COLUMNS: Record<ImportKind, { required: string[]; optional: string[]; example: string }> = {
  MAKES: { required: ["name"], optional: ["slug"], example: "name,slug\nSample Motors,sample-motors" },
  MODELS: { required: ["make_slug", "name", "vehicle_type"], optional: ["slug"], example: "make_slug,name,slug,vehicle_type\nsample-motors,Roadster,roadster,motorcycle" },
  VARIANTS: {
    required: ["make_slug", "model_slug", "name", "year_from"],
    optional: ["year_to", "engine_cc"],
    example: "make_slug,model_slug,name,year_from,year_to,engine_cc\nsample-motors,roadster,150 Standard,2018,2022,150",
  },
  PART_NUMBERS: {
    required: ["brand", "part_number", "category_slug"],
    optional: ["is_oem"],
    example: "brand,part_number,is_oem,category_slug\nSample Motors,SAMPLE-BRK-0101,yes,brake-pads",
  },
  INTERCHANGE: {
    required: ["brand_a", "part_number_a", "brand_b", "part_number_b", "type", "source"],
    optional: ["notes"],
    example: "brand_a,part_number_a,brand_b,part_number_b,type,source,notes\nSample Motors,SAMPLE-BRK-0101,Sample Motors,SAMPLE-BRK-0102,superseded_by,oem_catalogue,",
  },
  FITMENTS: {
    required: ["brand", "part_number", "make_slug", "model_slug", "variant_name", "variant_year_from"],
    optional: ["verdict", "source", "notes"],
    example: "brand,part_number,make_slug,model_slug,variant_name,variant_year_from,verdict,source,notes\nSample Motors,SAMPLE-BRK-0101,sample-motors,roadster,150 Standard,2018,fits,part_number_match,",
  },
};

export type RowAction = "create" | "update" | "unchanged" | "error";
export type RowReport = { line: number; key: string; action: RowAction; errors: string[] };
export type ImportReport = {
  kind: ImportKind;
  headerErrors: string[];
  rowCount: number;
  errorCount: number;
  counts: Record<Exclude<RowAction, "error">, number>;
  rows: RowReport[];
};

type Op =
  | { table: "vehicleMake"; id?: string; data: { name: string; slug: string } }
  | { table: "vehicleModel"; id?: string; data: { makeId: string; name: string; slug: string; vehicleType: "MOTORCYCLE" | "SCOOTER" } }
  | { table: "vehicleVariant"; id?: string; data: { modelId: string; name: string; yearFrom: number; yearTo: number | null; engineCc: number | null } }
  | { table: "partNumber"; id?: string; data: { display: string; normalized: string; brand: string; isOem: boolean; categoryId: string } }
  | { table: "interchangeLink"; id?: string; data: { partNumberAId: string; partNumberBId: string; type: InterchangeType; source: InterchangeSource; notes: string | null } }
  | { table: "fitment"; id?: string; data: { partNumberId: string; variantId: string; verdict: FitmentVerdict; source: FitmentSource; notes: string | null } };

// ───────────────────────────── snapshot of the current catalogue ─────────────────────────────

async function loadSnapshot(db: Tx | Db, kind: ImportKind) {
  const needParts = kind === "PART_NUMBERS" || kind === "INTERCHANGE" || kind === "FITMENTS";
  const [makes, models, variants, categories, parts, links, fitments] = await Promise.all([
    db.vehicleMake.findMany(),
    db.vehicleModel.findMany(),
    kind === "VARIANTS" || kind === "FITMENTS" ? db.vehicleVariant.findMany() : Promise.resolve([]),
    kind === "PART_NUMBERS" ? db.partCategory.findMany({ select: { id: true, slug: true } }) : Promise.resolve([]),
    needParts ? db.partNumber.findMany() : Promise.resolve([]),
    kind === "INTERCHANGE" ? db.interchangeLink.findMany({ where: { status: { not: "REJECTED" } } }) : Promise.resolve([]),
    kind === "FITMENTS" ? db.fitment.findMany({ where: { listingId: null } }) : Promise.resolve([]),
  ]);
  const makeBySlug = new Map(makes.map((m) => [m.slug, m]));
  const modelByKey = new Map(models.map((m) => [`${m.makeId}/${m.slug}`, m]));
  const variantByKey = new Map(variants.map((v) => [`${v.modelId}/${v.name.toLowerCase()}/${v.yearFrom}`, v]));
  const partByKey = new Map(parts.map((p) => [`${p.brand.toLowerCase()}/${p.normalized}`, p]));
  return { makes, makeBySlug, modelByKey, variantByKey, categoryBySlug: new Map(categories.map((c) => [c.slug, c])), partByKey, links, fitments };
}

// ───────────────────────────── parsing helpers ─────────────────────────────

const yes = new Set(["yes", "y", "true", "1"]);
const no = new Set(["no", "n", "false", "0", ""]);
function parseBool(v: string, errors: string[], column: string): boolean {
  const s = v.toLowerCase();
  if (yes.has(s)) return true;
  if (no.has(s)) return false;
  errors.push(`${column} must be yes or no.`);
  return false;
}
function parseYear(v: string, errors: string[], column: string, optional = false): number | null {
  if (optional && v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1950 || n > new Date().getFullYear() + 1) {
    errors.push(`${column} must be a year between 1950 and ${new Date().getFullYear() + 1}.`);
    return null;
  }
  return n;
}
function parseEnum<T extends string>(v: string, allowed: readonly T[], errors: string[], column: string, fallback?: T): T | null {
  if (v === "" && fallback) return fallback;
  const up = v.toUpperCase().replace(/[\s-]+/g, "_");
  if ((allowed as readonly string[]).includes(up)) return up as T;
  errors.push(`${column} must be one of: ${allowed.map((a) => a.toLowerCase()).join(", ")}.`);
  return null;
}
const limit = (v: string, max: number, errors: string[], column: string) => {
  if (v.length > max) errors.push(`${column} must be at most ${max} characters.`);
  return v;
};

// ───────────────────────────── validation ─────────────────────────────

export async function validateImport(db: Tx | Db, kind: ImportKind, content: string): Promise<{ report: ImportReport; ops: Op[] }> {
  const report: ImportReport = { kind, headerErrors: [], rowCount: 0, errorCount: 0, counts: { create: 0, update: 0, unchanged: 0 }, rows: [] };
  const ops: Op[] = [];

  let parsed: ReturnType<typeof csvToRecords>;
  try {
    parsed = csvToRecords(content);
  } catch (err) {
    report.headerErrors.push(err instanceof CsvParseError ? err.message : "The file isn't valid CSV.");
    report.errorCount = 1;
    return { report, ops };
  }
  const spec = IMPORT_COLUMNS[kind];
  const missing = spec.required.filter((c) => !parsed.headers.includes(c));
  const unknown = parsed.headers.filter((h) => !spec.required.includes(h) && !spec.optional.includes(h));
  if (missing.length) report.headerErrors.push(`Missing column(s): ${missing.join(", ")}.`);
  if (unknown.length) report.headerErrors.push(`Unknown column(s): ${unknown.join(", ")}. Expected: ${[...spec.required, ...spec.optional].join(", ")}.`);
  if (parsed.records.length === 0) report.headerErrors.push("The file has no data rows.");
  if (parsed.records.length > MAX_IMPORT_ROWS) report.headerErrors.push(`The file has ${parsed.records.length} rows; the limit is ${MAX_IMPORT_ROWS}. Split it into smaller files.`);
  report.rowCount = parsed.records.length;
  if (report.headerErrors.length) {
    report.errorCount = report.headerErrors.length;
    return { report, ops };
  }

  const snap = await loadSnapshot(db, kind);
  const seenKeys = new Map<string, number>();
  // Supersession links accepted earlier in this file count for cycle checks on later rows.
  const pendingSupersessions: Array<{ a: string; b: string; type: InterchangeType; status: "APPROVED" }> = [];

  for (const { line, values: v } of parsed.records) {
    const errors: string[] = [];
    let key = "";
    let dupKey = "";
    let op: Op | null = null;
    let unchanged = false;

    switch (kind) {
      case "MAKES": {
        const name = limit(v.name ?? "", 80, errors, "name");
        const slug = v.slug || slugify(name);
        key = slug;
        if (!name) errors.push("name is required.");
        if (!SLUG_PATTERN.test(slug)) errors.push("slug must use lowercase letters, digits and single dashes.");
        const existing = snap.makeBySlug.get(slug);
        const nameClash = snap.makes.find((m) => m.name.toLowerCase() === name.toLowerCase() && m.slug !== slug);
        if (nameClash) errors.push(`Another make (${nameClash.slug}) already uses the name ${name}.`);
        if (existing && existing.name === name) unchanged = true;
        else op = { table: "vehicleMake", id: existing?.id, data: { name, slug } };
        break;
      }
      case "MODELS": {
        const make = snap.makeBySlug.get(v.make_slug ?? "");
        const name = limit(v.name ?? "", 80, errors, "name");
        const slug = v.slug || slugify(name);
        const vehicleType = parseEnum(v.vehicle_type ?? "", ["MOTORCYCLE", "SCOOTER"] as const, errors, "vehicle_type");
        key = `${v.make_slug}/${slug}`;
        if (!make) errors.push(`No make with slug ${v.make_slug}. Import makes first.`);
        if (!name) errors.push("name is required.");
        if (!SLUG_PATTERN.test(slug)) errors.push("slug must use lowercase letters, digits and single dashes.");
        if (make && vehicleType) {
          const existing = snap.modelByKey.get(`${make.id}/${slug}`);
          if (existing && existing.name === name && existing.vehicleType === vehicleType) unchanged = true;
          else op = { table: "vehicleModel", id: existing?.id, data: { makeId: make.id, name, slug, vehicleType } };
        }
        break;
      }
      case "VARIANTS": {
        const make = snap.makeBySlug.get(v.make_slug ?? "");
        const model = make ? snap.modelByKey.get(`${make.id}/${v.model_slug}`) : undefined;
        const name = limit(v.name ?? "", 80, errors, "name");
        const yearFrom = parseYear(v.year_from ?? "", errors, "year_from");
        const yearTo = parseYear(v.year_to ?? "", errors, "year_to", true);
        const cc = v.engine_cc ? Number(v.engine_cc) : null;
        key = `${v.make_slug}/${v.model_slug}/${name}/${v.year_from}`;
        if (!model) errors.push(`No model ${v.make_slug}/${v.model_slug}. Import makes and models first.`);
        if (!name) errors.push("name is required.");
        if (cc !== null && (!Number.isInteger(cc) || cc <= 0 || cc > 3000)) errors.push("engine_cc must be a whole number of cc.");
        if (yearFrom && yearTo && yearTo < yearFrom) errors.push("year_to can't be before year_from.");
        if (model && yearFrom && !errors.length) {
          const existing = snap.variantByKey.get(`${model.id}/${name.toLowerCase()}/${yearFrom}`);
          if (existing && existing.yearTo === yearTo && existing.engineCc === cc && existing.name === name) unchanged = true;
          else op = { table: "vehicleVariant", id: existing?.id, data: { modelId: model.id, name, yearFrom, yearTo, engineCc: cc } };
        }
        break;
      }
      case "PART_NUMBERS": {
        const brand = limit(v.brand ?? "", 60, errors, "brand");
        const display = limit(v.part_number ?? "", 60, errors, "part_number");
        const normalized = normalizePartNumber(display);
        const isOem = parseBool(v.is_oem ?? "", errors, "is_oem");
        const category = snap.categoryBySlug.get(v.category_slug ?? "");
        key = `${brand}/${normalized}`;
        if (!brand) errors.push("brand is required.");
        if (normalized.length < 2) errors.push("part_number needs at least 2 letters or digits.");
        if (!category) errors.push(`No category with slug ${v.category_slug}.`);
        if (category && !errors.length) {
          const existing = snap.partByKey.get(`${brand.toLowerCase()}/${normalized}`);
          if (existing && existing.display === display && existing.isOem === isOem && existing.categoryId === category.id) unchanged = true;
          else op = { table: "partNumber", id: existing?.id, data: { display, normalized, brand: existing?.brand ?? brand, isOem, categoryId: category.id } };
        }
        break;
      }
      case "INTERCHANGE": {
        const pa = snap.partByKey.get(`${(v.brand_a ?? "").toLowerCase()}/${normalizePartNumber(v.part_number_a ?? "")}`);
        const pb = snap.partByKey.get(`${(v.brand_b ?? "").toLowerCase()}/${normalizePartNumber(v.part_number_b ?? "")}`);
        const type = parseEnum(v.type ?? "", ["EXACT_EQUIVALENT", "SUPERSEDED_BY", "FITS_WITH_MODIFICATION"] as const, errors, "type");
        const source = parseEnum(v.source ?? "", ["OEM_CATALOGUE", "BRAND_CROSS_REFERENCE", "MECHANIC_CONFIRMED", "ADMIN"] as const, errors, "source");
        const notes = limit(v.notes ?? "", 500, errors, "notes") || null;
        if (!pa) errors.push(`No part number ${v.part_number_a} from ${v.brand_a}. Import part numbers first.`);
        if (!pb) errors.push(`No part number ${v.part_number_b} from ${v.brand_b}. Import part numbers first.`);
        if (type === "FITS_WITH_MODIFICATION" && !notes) errors.push("notes are required for fits_with_modification: describe the modification.");
        if (pa && pb && pa.id === pb.id) errors.push("A part number can't be linked to itself.");
        key = `${v.brand_a} ${v.part_number_a} ${(v.type ?? "").toLowerCase()} ${v.brand_b} ${v.part_number_b}`;
        if (pa && pb && type && source && !errors.length) {
          const [a, b] = canonicalPair(type, pa.id, pb.id);
          dupKey = type === "SUPERSEDED_BY" ? `${a}/${b}` : [a, b].sort().join("/");
          const existing = snap.links.find((l) => (l.partNumberAId === a && l.partNumberBId === b) || (l.partNumberAId === b && l.partNumberBId === a));
          if (existing && existing.type !== type) {
            errors.push(`These parts are already linked as ${existing.type.toLowerCase()}. Change that link in the review queue instead.`);
          } else if (existing && (existing.partNumberAId !== a || existing.partNumberBId !== b)) {
            errors.push("This supersession already exists in the opposite direction.");
          } else if (type === "SUPERSEDED_BY" && !existing) {
            const chain = [...snap.links.map((l) => ({ a: l.partNumberAId, b: l.partNumberBId, type: l.type, status: l.status })), ...pendingSupersessions];
            if (wouldCreateSupersessionCycle(a, b, chain)) errors.push("This would make a loop of replacements (a number replacing itself). Check the direction.");
            else pendingSupersessions.push({ a, b, type, status: "APPROVED" });
          }
          if (!errors.length) {
            if (existing && existing.status === "APPROVED" && existing.source === source && existing.notes === notes) unchanged = true;
            else op = { table: "interchangeLink", id: existing?.id, data: { partNumberAId: a, partNumberBId: b, type, source, notes } };
          }
        }
        break;
      }
      case "FITMENTS": {
        const part = snap.partByKey.get(`${(v.brand ?? "").toLowerCase()}/${normalizePartNumber(v.part_number ?? "")}`);
        const make = snap.makeBySlug.get(v.make_slug ?? "");
        const model = make ? snap.modelByKey.get(`${make.id}/${v.model_slug}`) : undefined;
        const yearFrom = parseYear(v.variant_year_from ?? "", errors, "variant_year_from");
        const variant = model && yearFrom ? snap.variantByKey.get(`${model.id}/${(v.variant_name ?? "").toLowerCase()}/${yearFrom}`) : undefined;
        const verdict = parseEnum(v.verdict ?? "", ["FITS", "DOES_NOT_FIT"] as const, errors, "verdict", "FITS");
        const source = parseEnum(v.source ?? "", ["PART_NUMBER_MATCH", "MECHANIC_CONFIRMED"] as const, errors, "source", "PART_NUMBER_MATCH");
        const notes = limit(v.notes ?? "", 500, errors, "notes") || null;
        key = `${v.brand} ${v.part_number} on ${v.make_slug}/${v.model_slug}/${v.variant_name}/${v.variant_year_from}`;
        if (part && variant) dupKey = `${part.id}/${variant.id}`;
        if (!part) errors.push(`No part number ${v.part_number} from ${v.brand}.`);
        if (!variant && yearFrom) errors.push(`No variant ${v.variant_name} (${yearFrom}) of ${v.make_slug}/${v.model_slug}.`);
        if (part && variant && verdict && source && !errors.length) {
          const existing = snap.fitments.find((f) => f.partNumberId === part.id && f.variantId === variant.id);
          if (existing && existing.verdict === verdict && existing.source === source && existing.notes === notes) unchanged = true;
          else op = { table: "fitment", id: existing?.id, data: { partNumberId: part.id, variantId: variant.id, verdict, source, notes } };
        }
        break;
      }
    }

    dupKey ||= key.toLowerCase();
    const dupLine = dupKey ? seenKeys.get(dupKey) : undefined;
    if (dupLine) errors.push(`Duplicate of line ${dupLine}.`);
    else if (dupKey) seenKeys.set(dupKey, line);

    const action: RowAction = errors.length ? "error" : unchanged ? "unchanged" : op?.id ? "update" : "create";
    if (action === "error") report.errorCount++;
    else report.counts[action]++;
    if (op && action !== "error") ops.push(op);
    report.rows.push({ line, key, action, errors });
  }
  return { report, ops };
}

async function executeOps(tx: Tx, ops: Op[], actorId: string) {
  for (const op of ops) {
    switch (op.table) {
      case "vehicleMake":
        await (op.id ? tx.vehicleMake.update({ where: { id: op.id }, data: op.data }) : tx.vehicleMake.create({ data: op.data }));
        break;
      case "vehicleModel":
        await (op.id ? tx.vehicleModel.update({ where: { id: op.id }, data: op.data }) : tx.vehicleModel.create({ data: op.data }));
        break;
      case "vehicleVariant":
        await (op.id ? tx.vehicleVariant.update({ where: { id: op.id }, data: op.data }) : tx.vehicleVariant.create({ data: op.data }));
        break;
      case "partNumber":
        await (op.id ? tx.partNumber.update({ where: { id: op.id }, data: op.data }) : tx.partNumber.create({ data: op.data }));
        break;
      case "interchangeLink": {
        const reviewed = { status: "APPROVED" as const, reviewedById: actorId, reviewedAt: new Date() };
        await (op.id
          ? tx.interchangeLink.update({ where: { id: op.id }, data: { source: op.data.source, notes: op.data.notes, ...reviewed } })
          : tx.interchangeLink.create({ data: { ...op.data, ...reviewed } }));
        break;
      }
      case "fitment":
        await (op.id
          ? tx.fitment.update({ where: { id: op.id }, data: { verdict: op.data.verdict, source: op.data.source, notes: op.data.notes } })
          : tx.fitment.create({ data: { ...op.data, createdById: actorId } }));
        break;
    }
  }
}

// ───────────────────────────── upload, dry run, apply ─────────────────────────────

export type ImportDeps = { storage: StorageProvider; bucket: string };

/** Stores the file and runs the dry-run validation. Nothing in the catalogue changes. */
export async function createImport(db: Db, deps: ImportDeps, actor: Actor, input: { kind: ImportKind; fileName: string; content: string }) {
  const bytes = new TextEncoder().encode(input.content);
  if (bytes.byteLength === 0) throw new UserError("The file is empty.");
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new UserError(`The file is over ${MAX_IMPORT_BYTES / 1_000_000} MB. Split it into smaller files.`);
  const safeName = input.fileName.replace(/[^\w.-]+/g, "_").slice(0, 80) || "import.csv";
  const storageKey = `imports/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeName}`;
  await deps.storage.put(deps.bucket, storageKey, bytes, "text/csv");

  const { report } = await validateImport(db, input.kind, input.content);
  const failed = report.errorCount > 0;
  return db.catalogueImport.create({
    data: {
      kind: input.kind,
      fileName: safeName,
      storageKey,
      uploadedById: actor.userId,
      status: failed ? "FAILED" : "VALIDATED",
      rowCount: report.rowCount,
      errorCount: report.errorCount,
      report: report as unknown as Prisma.InputJsonValue,
    },
  });
}

export function listImports(db: Pick<Db, "catalogueImport">) {
  return db.catalogueImport.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
}

export async function getImport(db: Pick<Db, "catalogueImport">, id: string) {
  const row = await db.catalogueImport.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("import");
  return { ...row, report: row.report as unknown as ImportReport | null };
}

class StaleImportError extends Error {
  constructor(readonly report: ImportReport) {
    super("stale");
  }
}

/** Re-validates against the current catalogue and applies all rows in one transaction, or none. */
export async function applyImport(db: Db, deps: ImportDeps, actor: Actor, id: string) {
  const row = await getImport(db, id);
  if (row.status === "APPLIED") throw new UserError("This import has already been applied.");
  if (row.status !== "VALIDATED") throw new UserError("Only imports that passed validation can be applied. Fix the file and upload it again.");
  const bytes = await deps.storage.get(deps.bucket, row.storageKey);
  if (!bytes) throw new UserError("The uploaded file can't be found in storage. Upload it again.");
  const content = new TextDecoder().decode(bytes);

  try {
    return await db.$transaction(
      async (tx) => {
        // Claim first so two admins can't apply the same import.
        const claimed = await tx.catalogueImport.updateMany({ where: { id, status: "VALIDATED" }, data: { status: "APPLIED", appliedAt: new Date() } });
        if (claimed.count === 0) throw new UserError("This import is already being applied or has been applied.");
        const { report, ops } = await validateImport(tx, row.kind, content);
        if (report.errorCount > 0) throw new StaleImportError(report);
        await executeOps(tx, ops, actor.userId);
        await tx.catalogueImport.update({ where: { id }, data: { report: report as unknown as Prisma.InputJsonValue } });
        await recordAudit(tx, {
          actor: { type: "ADMIN", id: actor.userId },
          action: "catalogue.import_applied",
          entity: { type: "CatalogueImport", id },
          after: { kind: row.kind, fileName: row.fileName, ...report.counts },
          requestId: actor.requestId,
        });
        return report;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (err instanceof StaleImportError) {
      await db.catalogueImport.update({
        where: { id },
        data: { status: "FAILED", errorCount: err.report.errorCount, report: err.report as unknown as Prisma.InputJsonValue },
      });
      throw new UserError("The catalogue changed since this file was checked, and some rows are no longer valid. Nothing was applied. See the updated report.");
    }
    throw err;
  }
}
