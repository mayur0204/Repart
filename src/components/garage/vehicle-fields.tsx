"use client";

import { useMemo, useState } from "react";
import { FormInput, FormSelect } from "@/components/forms/action-form";

/** Structural copy of the server's VehicleCatalogue type. */
export type VehicleCatalogueData = Array<{
  id: string;
  name: string;
  models: Array<{ id: string; name: string; variants: Array<{ id: string; name: string; yearFrom: number; yearTo: number | null }> }>;
}>;

type Initial = { makeId: string; modelId: string; variantId: string; year: number; nickname: string | null };

/** Make, model, variant, year and nickname. Each choice narrows the next list. Submits variantId + year. */
export function VehicleFields({ catalogue, initial }: { catalogue: VehicleCatalogueData; initial?: Initial }) {
  const [makeId, setMakeId] = useState(initial?.makeId ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? "");
  const [variantId, setVariantId] = useState(initial?.variantId ?? "");
  const [year, setYear] = useState(initial ? String(initial.year) : "");

  const models = useMemo(() => catalogue.find((m) => m.id === makeId)?.models ?? [], [catalogue, makeId]);
  const variants = useMemo(() => models.find((m) => m.id === modelId)?.variants ?? [], [models, modelId]);
  const variant = variants.find((v) => v.id === variantId);
  const years = useMemo(() => {
    if (!variant) return [];
    const last = variant.yearTo ?? new Date().getFullYear();
    return Array.from({ length: last - variant.yearFrom + 1 }, (_, i) => last - i);
  }, [variant]);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormSelect
        label="Make"
        name="makeId"
        value={makeId}
        onChange={(e) => {
          setMakeId(e.target.value);
          setModelId("");
          setVariantId("");
          setYear("");
        }}
      >
        <option value="">Choose a make</option>
        {catalogue.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </FormSelect>
      <FormSelect
        label="Model"
        name="modelId"
        value={modelId}
        disabled={!makeId}
        onChange={(e) => {
          setModelId(e.target.value);
          setVariantId("");
          setYear("");
        }}
      >
        <option value="">{makeId ? "Choose a model" : "Choose a make first"}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </FormSelect>
      <FormSelect
        label="Variant"
        name="variantId"
        value={variantId}
        disabled={!modelId}
        onChange={(e) => {
          setVariantId(e.target.value);
          setYear("");
        }}
      >
        <option value="">{modelId ? "Choose a variant" : "Choose a model first"}</option>
        {variants.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name} ({v.yearFrom} to {v.yearTo ?? "now"})
          </option>
        ))}
      </FormSelect>
      <FormSelect label="Year" name="year" value={year} disabled={!variant} onChange={(e) => setYear(e.target.value)}>
        <option value="">{variant ? "Choose the year" : "Choose a variant first"}</option>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </FormSelect>
      <div className="sm:col-span-2">
        <FormInput
          label="Nickname (optional)"
          name="nickname"
          defaultValue={initial?.nickname ?? ""}
          maxLength={40}
          help="Helps you tell bikes apart, for example 'Daily ride'."
        />
      </div>
    </div>
  );
}
