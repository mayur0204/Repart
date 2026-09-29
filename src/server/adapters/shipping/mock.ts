import "server-only";
import { verifySignature } from "../signing";
import type { Parcel, Pincode, ShippingProvider, TrackingEvent } from "./types";

export const MOCK_SHIPPING_SIGNATURE_HEADER = "x-mock-signature";

/** Deterministic distance band: same sorting district (first 3 digits) = 0, same postal zone (first digit) = 1, else 2. */
export function distanceBand(from: Pincode, to: Pincode): 0 | 1 | 2 {
  if (from.slice(0, 3) === to.slice(0, 3)) return 0;
  if (from[0] === to[0]) return 1;
  return 2;
}

const BAND_BASE_PAISE = [6000, 9000, 14000] as const;
const BAND_ETA_DAYS = [2, 4, 6] as const;
const PER_EXTRA_KG_PAISE = 3000;

export function mockQuotePaise(from: Pincode, to: Pincode, parcel: Parcel): number {
  const volumetricGrams = (parcel.lengthCm * parcel.widthCm * parcel.heightCm) / 5; // 5000 cm3 per kg
  const billableKg = Math.max(1, Math.ceil(Math.max(parcel.weightGrams, volumetricGrams) / 1000));
  return BAND_BASE_PAISE[distanceBand(from, to)] + (billableKg - 1) * PER_EXTRA_KG_PAISE;
}

const isPincode = (p: string) => /^[1-9]\d{5}$/.test(p);

export function createMockShippingProvider(opts: { webhookSecret: string }): ShippingProvider {
  let seq = 0;
  const book = (orderId: string, pickupSlot: Date, prefix: string) => {
    seq += 1;
    return { shipmentId: `${prefix}_${orderId}_${seq}`, awb: `MOCKAWB${String(seq).padStart(8, "0")}`, pickupAt: pickupSlot };
  };
  return {
    name: "mock",
    async checkServiceability(from, to) {
      if (!isPincode(from) || !isPincode(to)) return { serviceable: false };
      return { serviceable: true, etaDays: BAND_ETA_DAYS[distanceBand(from, to)] };
    },
    async quote(from, to, parcel) {
      return { amount: mockQuotePaise(from, to, parcel), etaDays: BAND_ETA_DAYS[distanceBand(from, to)], courier: "Mock Courier" };
    },
    async bookPickup(input) {
      return book(input.orderId, input.pickupSlot, "mock_ship");
    },
    async cancel() {},
    async bookReturn(input) {
      return book(input.orderId, input.pickupSlot, "mock_return");
    },
    verifyWebhook(rawBody, headers) {
      return verifySignature(opts.webhookSecret, rawBody, headers.get(MOCK_SHIPPING_SIGNATURE_HEADER));
    },
    parseTracking(rawBody) {
      const raw = JSON.parse(rawBody) as Omit<TrackingEvent, "at"> & { at: string };
      return { ...raw, at: new Date(raw.at) };
    },
  };
}
