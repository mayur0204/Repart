import { DateText } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { SHIPMENT_TEXT, type TimelineStep } from "@/lib/order-state";

/** Vertical order timeline with the current step marked (PLAN.md §4.5). */
export function OrderTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="flex flex-col" aria-label="Order progress">
      {steps.map((s) => (
        <li key={s.state} className="flex gap-3 border-l-2 border-rule pb-3 pl-3" aria-current={s.status === "current" ? "step" : undefined}>
          <span className={s.status === "upcoming" ? "text-steel" : s.status === "current" ? "font-semibold" : ""}>
            {s.status === "done" ? <Icon name="check" size="sm" className="mr-1 inline" /> : null}
            {s.label}
            {s.status === "current" ? <span className="text-sm text-steel"> (now)</span> : null}
          </span>
          {s.at ? <DateText date={s.at} className="ml-auto text-sm text-steel" /> : null}
        </li>
      ))}
    </ol>
  );
}

type Shipment = {
  status: string;
  awb: string | null;
  pickupSlotStart: Date | null;
  pickupSlotEnd: Date | null;
  etaDate: Date | null;
  trackingEvents: Array<{ status: string; description: string; location: string | null; occurredAt: Date }>;
};

/** Courier tracking: status, AWB, pickup slot and every tracking event. */
export function ShipmentTracking({ shipment }: { shipment: Shipment }) {
  return (
    <div className="flex flex-col gap-2">
      <p>
        <span className="font-semibold">{SHIPMENT_TEXT[shipment.status] ?? shipment.status}</span>
        {shipment.awb ? <span className="text-sm text-steel"> (tracking number {shipment.awb})</span> : null}
      </p>
      {shipment.pickupSlotStart ? (
        <p className="text-sm">
          Pickup slot: <DateText date={shipment.pickupSlotStart} /> {shipment.pickupSlotStart.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}
          {shipment.pickupSlotEnd ? ` to ${shipment.pickupSlotEnd.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}` : ""}
        </p>
      ) : null}
      {shipment.etaDate && !["DELIVERED", "CANCELLED", "RETURNED_TO_ORIGIN"].includes(shipment.status) ? (
        <p className="text-sm text-steel">
          Expected by <DateText date={shipment.etaDate} />
        </p>
      ) : null}
      {shipment.trackingEvents.length ? (
        <ul className="flex flex-col text-sm">
          {shipment.trackingEvents.map((e, i) => (
            <li key={i} className="flex justify-between gap-4 border-b border-rule py-1">
              <span>
                {e.description}
                {e.location ? `, ${e.location}` : ""}
              </span>
              <DateText date={e.occurredAt} className="text-steel" />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
