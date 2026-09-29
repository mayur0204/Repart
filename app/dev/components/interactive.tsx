"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { OptionTileGroup, SegmentedControl } from "@/components/ui/choice";
import { Dialog, Sheet } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";

/** Client-side demos for the component gallery. */
export function ChoiceDemo() {
  const [grade, setGrade] = useState<"new" | "used" | "worn" | "parts" | null>("used");
  const [works, setWorks] = useState<"yes" | "no" | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <OptionTileGroup
        legend="Condition"
        value={grade}
        onChange={setGrade}
        options={[
          { value: "new", label: "New, unused", description: "Still in original packaging." },
          { value: "used", label: "Used, working", description: "Removed from a running bike." },
          { value: "worn", label: "Worn", description: "Works, with visible wear." },
          { value: "parts", label: "For parts", description: "Not available for this category.", disabled: true },
        ]}
      />
      <SegmentedControl
        legend="Does the part turn freely by hand?"
        value={works}
        onChange={setWorks}
        options={[
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ]}
      />
    </div>
  );
}

export function OverlayDemo() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => setDialog(true)}>
        Open dialog
      </Button>
      <Button variant="secondary" onClick={() => setSheet(true)}>
        Open sheet
      </Button>
      <Button variant="secondary" onClick={() => toast("Part listed", "success")}>
        Show success toast
      </Button>
      <Button variant="secondary" onClick={() => toast("Photo upload failed. Check your connection and try again.", "error")}>
        Show error toast
      </Button>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Remove this photo?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(false)}>
              Keep photo
            </Button>
            <Button variant="danger" onClick={() => setDialog(false)}>
              Remove photo
            </Button>
          </>
        }
      >
        <p>The photo is deleted from this listing. You can add another one before you submit.</p>
      </Dialog>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Filters">
        <p className="text-steel">Search filters arrive in M6.</p>
      </Sheet>
    </div>
  );
}
