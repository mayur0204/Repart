"use client";

import { useState } from "react";
import { SegmentedControl } from "@/components/ui/choice";
import { VehicleFields, type VehicleCatalogueData } from "@/components/garage/vehicle-fields";
import { OptionTileGroup } from "@/components/ui/choice";

type GarageBike = { id: string; label: string; nickname: string | null };

/** Step 1: one of the seller's garage bikes, or any bike from the catalogue. */
export function BikeFields({ garage, catalogue, currentVariantId }: { garage: GarageBike[]; catalogue: VehicleCatalogueData; currentVariantId: string | null }) {
  const [source, setSource] = useState<"garage" | "catalogue">(garage.length ? "garage" : "catalogue");
  const [garageId, setGarageId] = useState<string | null>(garage[0]?.id ?? null);
  const initial = (() => {
    if (!currentVariantId) return undefined;
    for (const make of catalogue)
      for (const model of make.models)
        for (const v of model.variants) if (v.id === currentVariantId) return { makeId: make.id, modelId: model.id, variantId: v.id, year: v.yearFrom, nickname: null };
    return undefined;
  })();

  return (
    <div className="flex flex-col gap-4">
      <input type="hidden" name="source" value={source} />
      {garage.length ? (
        <SegmentedControl
          legend="Where did this part come from?"
          value={source}
          onChange={setSource}
          options={[
            { value: "garage", label: "One of my bikes" },
            { value: "catalogue", label: "Another bike" },
          ]}
        />
      ) : null}
      {source === "garage" ? (
        <>
          <input type="hidden" name="garageVehicleId" value={garageId ?? ""} />
          <OptionTileGroup legend="Your bikes" value={garageId} onChange={setGarageId} options={garage.map((g) => ({ value: g.id, label: g.label, description: g.nickname ?? undefined }))} />
        </>
      ) : (
        <VehicleFields catalogue={catalogue} initial={initial} />
      )}
    </div>
  );
}
