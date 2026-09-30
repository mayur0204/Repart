import { DateText } from "@/components/ui/display";

type Inspection = {
  status: string;
  reason: string;
  slotStart: Date | null;
  slotEnd: Date | null;
  outcome: string | null;
  notes: string | null;
  completedAt: Date | null;
  partner: { garageName: string };
} | null;

const time = (d: Date | null) => (d ? d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");
const RESULT = { PASS: "Passed", PASS_WITH_NOTES: "Passed with notes", FAIL: "Failed" } as Record<string, string>;

/** The order's Partner Check: why, when, which garage, and the result with notes (M10). Never "certified" or "guaranteed". */
export function PartnerCheckPanel({ inspection, audience, reason, waitingForSeller }: { inspection: Inspection; audience: "buyer" | "seller"; reason?: string | null; waitingForSeller?: boolean }) {
  return (
    <section className="flex flex-col gap-2 border border-rule bg-surface p-4">
      <h2 className="text-xl">Partner Check</h2>
      {(reason ?? inspection?.reason) === "AUDIT" ? <p className="text-sm">This order was picked for a routine quality check</p> : null}
      {!inspection ? (
        <p>
          {waitingForSeller
            ? "A partner garage checks the part at the seller's address before it is sent. The appointment is booked when the seller confirms."
            : audience === "seller"
              ? "RePart is arranging a partner garage for the check. You'll be told the appointment. Keep the part ready."
              : "RePart is arranging the Partner Check with a partner garage."}
        </p>
      ) : inspection.status === "COMPLETED" ? (
        <>
          <p>
            <span className="font-semibold">{RESULT[inspection.outcome ?? ""] ?? "Done"}</span>
            {inspection.completedAt ? (
              <>
                . Inspected by {inspection.partner.garageName} on <DateText date={inspection.completedAt} />. Visual and basic check.
              </>
            ) : null}
          </p>
          {inspection.notes ? <p className="border-l-2 border-rule pl-3 text-sm">{inspection.notes}</p> : null}
        </>
      ) : inspection.status === "SCHEDULED" ? (
        <p>
          {inspection.partner.garageName} will check the part
          {inspection.slotStart ? (
            <>
              {" "}on <DateText date={inspection.slotStart} />, {time(inspection.slotStart)} to {time(inspection.slotEnd)}
            </>
          ) : null}
          {audience === "seller" ? ", at your pickup address. Keep the part ready." : "."}
        </p>
      ) : (
        <p className="text-sm text-steel">The appointment is being rearranged by RePart.</p>
      )}
    </section>
  );
}
