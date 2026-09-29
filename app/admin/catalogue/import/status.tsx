import { Badge } from "@/components/ui/display";

export const KIND_LABELS = {
  MAKES: "Makes",
  MODELS: "Models",
  VARIANTS: "Variants",
  PART_NUMBERS: "Part numbers",
  INTERCHANGE: "Interchange links",
  FITMENTS: "Part-number fitments",
} as const;

export function StatusBadge({ status }: { status: "VALIDATING" | "VALIDATED" | "APPLIED" | "FAILED" }) {
  if (status === "APPLIED") return <Badge tone="fit">Applied</Badge>;
  if (status === "VALIDATED") return <Badge tone="neutral">Checked, ready to apply</Badge>;
  if (status === "FAILED") return <Badge tone="danger">Has problems</Badge>;
  return <Badge tone="caution">Checking</Badge>;
}
