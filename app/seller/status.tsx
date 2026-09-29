import type { ListingStatus } from "@/server/services/listing/listing";
import { Badge, type Tone } from "@/components/ui/display";

export const STATUS_LABEL: Record<ListingStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "neutral" },
  SCREENING: { label: "Being checked", tone: "neutral" },
  CHANGES_REQUESTED: { label: "Changes needed", tone: "caution" },
  LIVE: { label: "Live", tone: "fit" },
  RESERVED: { label: "Ordered", tone: "neutral" },
  SOLD: { label: "Sold", tone: "fit" },
  REJECTED: { label: "Not accepted", tone: "danger" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
};

export function StatusBadge({ status }: { status: ListingStatus }) {
  return <Badge tone={STATUS_LABEL[status].tone}>{STATUS_LABEL[status].label}</Badge>;
}
