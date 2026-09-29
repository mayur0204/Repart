"use client";

import { useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import type { VehicleCatalogueData } from "@/components/garage/vehicle-fields";

/**
 * "What do you ride?" (brief §9 Home): make, model, variant and year, submitted as a plain GET form
 * so it works without signing in. Extra hidden params (e.g. the current search) are kept.
 */
export function VehiclePicker({
  catalogue,
  action,
  submitLabel,
  keep = {},
  initial,
}: {
  catalogue: VehicleCatalogueData;
  action: string;
  submitLabel: string;
  keep?: Record<string, string | undefined>;
  initial?: { variantId?: string; year?: number };
}) {
  const start = (() => {
    for (const make of catalogue) for (const model of make.models) for (const v of model.variants) if (v.id === initial?.variantId) return { make: make.id, model: model.id };
    return { make: "", model: "" };
  })();
  const [makeId, setMakeId] = useState(start.make);
  const [modelId, setModelId] = useState(start.model);
  const [variantId, setVariantId] = useState(initial?.variantId ?? "");
  const [year, setYear] = useState(initial?.year ? String(initial.year) : "");
  const models = catalogue.find((m) => m.id === makeId)?.models ?? [];
  const variants = models.find((m) => m.id === modelId)?.variants ?? [];
  const variant = variants.find((v) => v.id === variantId);
  const years = variant ? Array.from({ length: (variant.yearTo ?? new Date().getFullYear()) - variant.yearFrom + 1 }, (_, i) => (variant.yearTo ?? new Date().getFullYear()) - i) : [];
  const select = "min-h-11 w-full border border-rule bg-surface px-3 disabled:bg-page disabled:text-steel";

  return (
    <form method="get" action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end">
      {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Make
        <select className={select} value={makeId} onChange={(e) => { setMakeId(e.target.value); setModelId(""); setVariantId(""); setYear(""); }}>
          <option value="">Choose</option>
          {catalogue.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Model
        <select className={select} value={modelId} disabled={!makeId} onChange={(e) => { setModelId(e.target.value); setVariantId(""); setYear(""); }}>
          <option value="">Choose</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Variant
        <select className={select} name="vehicle" value={variantId} disabled={!modelId} onChange={(e) => { setVariantId(e.target.value); setYear(""); }}>
          <option value="">Choose</option>
          {variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Year
        <select className={select} name="year" value={year} disabled={!variant} onChange={(e) => setYear(e.target.value)}>
          <option value="">Any</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>
      <button type="submit" disabled={!variantId} className={buttonClasses("primary")}>
        {submitLabel}
      </button>
    </form>
  );
}
