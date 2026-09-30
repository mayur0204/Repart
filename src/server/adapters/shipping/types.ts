import type { Paise } from "../payment/types";

export type Pincode = string;
export type Parcel = { weightGrams: number; lengthCm: number; widthCm: number; heightCm: number };
export type Serviceability = { serviceable: boolean; etaDays?: number };
export type ShippingQuote = { amount: Paise; etaDays: number; courier: string };
export type Shipment = { shipmentId: string; awb: string; pickupAt: Date };
export type TrackingEvent = {
  providerEventId: string;
  shipmentId: string;
  /** DELIVERY_FAILED: an attempt failed (may be re-attempted). RETURNED: back with the seller (RTO). */
  status: "BOOKED" | "PICKED_UP" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "DELIVERY_FAILED" | "RETURNED" | "CANCELLED";
  at: Date;
  location?: string;
};

export type BookingInput = { orderId: string; from: Pincode; to: Pincode; parcel: Parcel; pickupSlot: Date };

/** Courier partner (REPART_BRIEF.md §3). */
export interface ShippingProvider {
  readonly name: string;
  checkServiceability(from: Pincode, to: Pincode): Promise<Serviceability>;
  quote(from: Pincode, to: Pincode, parcel: Parcel): Promise<ShippingQuote>;
  bookPickup(input: BookingInput): Promise<Shipment>;
  cancel(shipmentId: string): Promise<void>;
  bookReturn(input: BookingInput): Promise<Shipment>;
  /** Signature + timestamp (replay) check on the raw body. Never throws for bad input. */
  verifyWebhook(rawBody: string, headers: Headers, now?: Date): boolean;
  parseTracking(rawBody: string): TrackingEvent;
}
