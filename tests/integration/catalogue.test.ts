import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMemoryStorageProvider } from "../../src/server/adapters/storage/memory";
import { FieldError, UserError } from "../../src/server/http/errors";
import { deleteMake, deletePartNumber, deleteVariant, saveMake, saveModel, savePartNumber, saveVariant } from "../../src/server/services/catalogue/admin";
import { deleteCategory, saveCategory } from "../../src/server/services/catalogue/categories";
import { applyImport, createImport, getImport, validateImport } from "../../src/server/services/catalogue/import";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const admin = { userId: "sample-user-admin", requestId: "req-cat" };
const deps = { storage: createMemoryStorageProvider(), bucket: "catalogue-imports" };
const tag = `t${Date.now().toString(36)}`;

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
/** Remove the non-SAMPLE catalogue rows this file created, so other suites still see a SAMPLE-only catalogue. */
afterAll(async () => {
  const parts = { isSample: false };
  await db.interchangeLink.deleteMany({ where: { OR: [{ partNumberA: parts }, { partNumberB: parts }] } });
  await db.fitment.deleteMany({ where: { partNumber: parts } });
  await db.partNumber.deleteMany({ where: parts });
  await db.vehicleVariant.deleteMany({ where: { isSample: false } });
  await db.vehicleModel.deleteMany({ where: { isSample: false } });
  await db.vehicleMake.deleteMany({ where: { isSample: false } });
  await db.$disconnect();
});

describe("catalogue CRUD (admin)", () => {
  it("creates and edits a make, model, variant and part number, each audited", async () => {
    const make = await saveMake(db, admin, { name: `Make ${tag}` });
    expect(make.slug).toBe(`make-${tag}`);
    const model = await saveModel(db, admin, { makeId: make.id, name: "Tourer 300", vehicleType: "MOTORCYCLE" });
    const variant = await saveVariant(db, admin, { modelId: model.id, name: "Standard", yearFrom: "2020", yearTo: "" });
    expect(variant.yearTo).toBeNull();
    const cat = await db.partCategory.findUniqueOrThrow({ where: { slug: "mirrors" } });
    const pn = await savePartNumber(db, admin, { display: `SAMPLE-${tag}-01`, brand: "Sample Motors", isOem: "on", categoryId: cat.id });
    expect(pn.normalized).toBe(`SAMPLE${tag.toUpperCase()}01`);

    const renamed = await saveMake(db, admin, { id: make.id, name: `Make ${tag} renamed`, slug: make.slug });
    expect(renamed.name).toBe(`Make ${tag} renamed`);
    const actions = (await db.auditLog.findMany({ where: { entityId: { in: [make.id, model.id, variant.id, pn.id] } }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["catalogue.make_created", "catalogue.model_created", "catalogue.variant_created", "catalogue.part_number_created", "catalogue.make_updated"]);
    const updated = await db.auditLog.findFirstOrThrow({ where: { entityId: make.id, action: "catalogue.make_updated" } });
    expect(updated.before).toMatchObject({ name: `Make ${tag}` });
    expect(updated.after).toMatchObject({ name: `Make ${tag} renamed` });
  });

  it("rejects duplicates as field errors, including part numbers that differ only in spacing", async () => {
    await expect(saveMake(db, admin, { name: "Sample Motors" })).rejects.toBeInstanceOf(FieldError);
    const cat = await db.partCategory.findUniqueOrThrow({ where: { slug: "brake-pads" } });
    await expect(savePartNumber(db, admin, { display: "sample brk 0001", brand: "Sample Motors", categoryId: cat.id })).rejects.toBeInstanceOf(FieldError);
  });

  it("validates variant years", async () => {
    await expect(saveVariant(db, admin, { modelId: "sample-model-street-150", name: `V ${tag}`, yearFrom: "2022", yearTo: "2020" })).rejects.toThrow();
  });

  it("refuses to delete rows that are still referenced, and deletes unused ones", async () => {
    await expect(deleteMake(db, admin, "sample-make-sample-motors")).rejects.toBeInstanceOf(UserError);
    await expect(deleteVariant(db, admin, "sample-variant-street-150-std")).rejects.toBeInstanceOf(UserError);
    await expect(deletePartNumber(db, admin, "sample-pn-brk-0001")).rejects.toBeInstanceOf(UserError);
    const make = await saveMake(db, admin, { name: `Delete me ${tag}` });
    await deleteMake(db, admin, make.id);
    expect(await db.vehicleMake.findUnique({ where: { id: make.id } })).toBeNull();
    expect(await db.auditLog.count({ where: { entityId: make.id, action: "catalogue.make_deleted" } })).toBe(1);
  });

  it("saves categories with money in paise and refuses to delete used ones", async () => {
    const cat = await saveCategory(db, admin, {
      name: `Levers ${tag}`,
      inspectionTier: "B_CONDITIONAL",
      inspectionValueThresholdRupees: "2500",
      optionalCheckFeeRupees: "99",
      optionalCheckEnabled: "on",
      shippingRestriction: "NONE",
      packagingGuide: "Wrap in bubble wrap and pack in a box.",
      conditionChecklist: '[{"id":"bent","question":"Is it bent?","weight":30,"badAnswer":"YES","blocksListing":false}]',
      photoGuide: '[{"shotType":"side","label":"Side","instructions":"Show the full lever.","required":true}]',
    });
    expect([cat.inspectionValueThreshold, cat.optionalCheckFee]).toEqual([250000, 9900]);
    await expect(deleteCategory(db, admin, (await db.partCategory.findUniqueOrThrow({ where: { slug: "brake-pads" } })).id)).rejects.toBeInstanceOf(UserError);
    await deleteCategory(db, admin, cat.id);
  });
});

describe("CSV import: validate, report, apply", () => {
  it("a dry run reports creates, updates, unchanged and errors without writing anything", async () => {
    const csv = `name,slug\nSample Motors,sample-motors\nSample Motors Renamed ${tag},demo-wheels\nNew Make ${tag},new-make-${tag}\n,bad slug\n`;
    const before = await db.vehicleMake.count();
    const { report, ops } = await validateImport(db, "MAKES", csv);
    expect(report.counts).toEqual({ create: 1, update: 1, unchanged: 1 });
    expect(report.errorCount).toBe(1);
    expect(report.rows.find((r) => r.line === 5)?.errors.join(" ")).toMatch(/name is required/);
    expect(ops).toHaveLength(2);
    expect(await db.vehicleMake.count()).toBe(before);
  });

  it("reports missing and unknown columns", async () => {
    const { report } = await validateImport(db, "MODELS", "make,name\nx,y\n");
    expect(report.headerErrors.join(" ")).toMatch(/Missing column\(s\): make_slug, vehicle_type/);
    expect(report.headerErrors.join(" ")).toMatch(/Unknown column\(s\): make/);
  });

  it("flags duplicate rows and unresolved references", async () => {
    const csv = `brand,part_number,is_oem,category_slug\nSample Motors,SAMPLE-${tag}-9,yes,mirrors\nSample Motors,sample ${tag} 9,no,mirrors\nSample Motors,SAMPLE-${tag}-8,maybe,nope\n`;
    const { report } = await validateImport(db, "PART_NUMBERS", csv);
    expect(report.rows[1]?.errors).toContain("Duplicate of line 2.");
    expect(report.rows[2]?.errors.join(" ")).toMatch(/is_oem must be yes or no.*No category with slug nope/);
  });

  it("stores the file, then applies it in one transaction with an audit entry; applying twice is refused", async () => {
    const csv = `brand,part_number,is_oem,category_slug\nSample Motors,SAMPLE-${tag}-A,yes,mirrors\nSample Aftermarket,SAMPLE-${tag}-B,no,mirrors\n`;
    const row = await createImport(db, deps, admin, { kind: "PART_NUMBERS", fileName: "parts.csv", content: csv });
    expect(row.status).toBe("VALIDATED");
    expect(await db.partNumber.count({ where: { display: { in: [`SAMPLE-${tag}-A`, `SAMPLE-${tag}-B`] } } })).toBe(0);

    const report = await applyImport(db, deps, admin, row.id);
    expect(report.counts.create).toBe(2);
    expect(await db.partNumber.count({ where: { display: { in: [`SAMPLE-${tag}-A`, `SAMPLE-${tag}-B`] } } })).toBe(2);
    expect((await getImport(db, row.id)).status).toBe("APPLIED");
    expect(await db.auditLog.count({ where: { entityId: row.id, action: "catalogue.import_applied" } })).toBe(1);
    await expect(applyImport(db, deps, admin, row.id)).rejects.toThrow(/already been applied/);
  });

  it("files with problems can't be applied", async () => {
    const row = await createImport(db, deps, admin, { kind: "MAKES", fileName: "bad.csv", content: "name\n\n,\n" });
    expect(row.status).toBe("FAILED");
    await expect(applyImport(db, deps, admin, row.id)).rejects.toThrow(/passed validation/);
  });

  it("re-validates at apply time: if the catalogue changed, nothing is applied and the report is updated", async () => {
    const make = await saveMake(db, admin, { name: `Stale ${tag}` });
    const csv = `make_slug,name,slug,vehicle_type\n${make.slug},Model One,model-one,motorcycle\n${make.slug},Model Two,model-two,scooter\n`;
    const row = await createImport(db, deps, admin, { kind: "MODELS", fileName: "models.csv", content: csv });
    expect(row.status).toBe("VALIDATED");
    await deleteMake(db, admin, make.id); // the make disappears after the dry run
    await expect(applyImport(db, deps, admin, row.id)).rejects.toThrow(/catalogue changed/);
    const after = await getImport(db, row.id);
    expect(after.status).toBe("FAILED");
    expect(after.report?.errorCount).toBe(2);
    expect(await db.vehicleModel.count({ where: { slug: { in: ["model-one", "model-two"] }, make: { slug: make.slug } } })).toBe(0);
  });

  it("interchange rows: approved on apply, modification needs notes, supersession loops rejected", async () => {
    const cat = await db.partCategory.findUniqueOrThrow({ where: { slug: "mirrors" } });
    for (const n of ["X1", "X2", "X3"]) await savePartNumber(db, admin, { display: `SAMPLE-${tag}-${n}`, brand: "Sample Motors", categoryId: cat.id });
    const p = (n: string) => `Sample Motors,SAMPLE-${tag}-${n}`;
    const header = "brand_a,part_number_a,brand_b,part_number_b,type,source,notes";
    const csv = [header, `${p("X1")},${p("X2")},superseded_by,oem_catalogue,`, `${p("X2")},${p("X3")},superseded_by,oem_catalogue,`, `${p("X3")},${p("X1")},superseded_by,oem_catalogue,`, `${p("X1")},${p("X3")},fits_with_modification,admin,`].join("\n");
    const { report } = await validateImport(db, "INTERCHANGE", csv);
    expect(report.rows.map((r) => r.action)).toEqual(["create", "create", "error", "error"]);
    expect(report.rows[2]?.errors.join(" ")).toMatch(/loop of replacements/);
    expect(report.rows[3]?.errors.join(" ")).toMatch(/notes are required/);

    const good = [header, `${p("X1")},${p("X2")},superseded_by,oem_catalogue,`].join("\n");
    const row = await createImport(db, deps, admin, { kind: "INTERCHANGE", fileName: "links.csv", content: good });
    await applyImport(db, deps, admin, row.id);
    const link = await db.interchangeLink.findFirstOrThrow({ where: { partNumberA: { display: `SAMPLE-${tag}-X1` } } });
    expect(link).toMatchObject({ status: "APPROVED", type: "SUPERSEDED_BY", source: "OEM_CATALOGUE", reviewedById: admin.userId });
  });

  it("fitment rows resolve part number and variant and update existing fitments", async () => {
    const csv = "brand,part_number,make_slug,model_slug,variant_name,variant_year_from,verdict,source,notes\nSample Motors,SAMPLE-BRK-0001,sample-motors,street-150,Standard,2018,fits,mechanic_confirmed,checked\nSample Motors,SAMPLE-BRK-0001,sample-motors,street-150,Nope,2018,fits,,\n";
    const { report } = await validateImport(db, "FITMENTS", csv);
    expect(report.rows.map((r) => r.action)).toEqual(["update", "error"]);
  });
});
