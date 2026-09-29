import { describe, expect, it } from "vitest";
import { createMockNotificationProvider } from "@/server/adapters/notification/mock";
import { createMockOtpProvider, MOCK_OTP_CODE } from "@/server/adapters/otp/mock";
import { createMockPaymentProvider, MOCK_SIGNATURE_HEADER } from "@/server/adapters/payment/mock";
import { createMockShippingProvider, distanceBand } from "@/server/adapters/shipping/mock";
import { signBody } from "@/server/adapters/signing";
import { createMemoryStorageProvider } from "@/server/adapters/storage/memory";
import { createMockVisionProvider, imageHash } from "@/server/adapters/vision/mock";

const silent = () => {};

describe("mock OtpProvider", () => {
  it("accepts only the fixed code and never logs the full phone number", async () => {
    const lines: string[] = [];
    const otp = createMockOtpProvider((l) => lines.push(l));
    await otp.send("+919876543210");
    expect(lines.join("")).not.toContain("9876543210");
    expect((await otp.verify("+919876543210", MOCK_OTP_CODE)).valid).toBe(true);
    expect((await otp.verify("+919876543210", "123456")).valid).toBe(false);
  });
});

describe("mock PaymentProvider", () => {
  const secret = "test-secret-0123456789";
  const payment = createMockPaymentProvider({ webhookSecret: secret, baseUrl: "http://localhost:3000" });

  it("verifies only correctly signed webhooks", () => {
    const body = JSON.stringify({ providerEventId: "e1", type: "PAYMENT_SUCCESS", data: {} });
    expect(payment.verifyWebhook(body, new Headers({ [MOCK_SIGNATURE_HEADER]: signBody(secret, body) }))).toBe(true);
    expect(payment.verifyWebhook(body, new Headers({ [MOCK_SIGNATURE_HEADER]: signBody("wrong-secret-000000", body) }))).toBe(false);
    expect(payment.verifyWebhook(body, new Headers())).toBe(false);
    expect(payment.parseWebhook(body).providerEventId).toBe("e1");
  });

  it("is idempotent on order creation and refunds", async () => {
    const input = { orderId: "o1", amount: 1_050_000, vendorId: "v1", vendorShare: 970_000, customer: { id: "u1", phone: "+910000000000" }, returnUrl: "/", idempotencyKey: "k1" };
    const a = await payment.createOrder(input);
    const b = await payment.createOrder(input);
    expect(b.providerOrderId).toBe(a.providerOrderId);
    const r1 = await payment.refund({ orderId: "o1", amount: 100, splitReversal: 100, idempotencyKey: "r1" });
    const r2 = await payment.refund({ orderId: "o1", amount: 100, splitReversal: 100, idempotencyKey: "r1" });
    expect(r2.providerRefundId).toBe(r1.providerRefundId);
  });
});

describe("mock ShippingProvider", () => {
  const shipping = createMockShippingProvider({ webhookSecret: "test-secret-0123456789" });
  const parcel = { weightGrams: 800, lengthCm: 20, widthCm: 15, heightCm: 10 };

  it("bands distance by pincode prefix", () => {
    expect(distanceBand("560001", "560102")).toBe(0);
    expect(distanceBand("560001", "570001")).toBe(1);
    expect(distanceBand("560001", "110001")).toBe(2);
  });

  it("quotes deterministically and more for further and heavier parcels", async () => {
    const near = await shipping.quote("560001", "560102", parcel);
    expect(await shipping.quote("560001", "560102", parcel)).toEqual(near);
    const far = await shipping.quote("560001", "110001", parcel);
    expect(far.amount).toBeGreaterThan(near.amount);
    const heavy = await shipping.quote("560001", "560102", { ...parcel, weightGrams: 3500 });
    expect(heavy.amount).toBeGreaterThan(near.amount);
    expect(Number.isInteger(heavy.amount)).toBe(true);
  });

  it("rejects malformed pincodes as not serviceable", async () => {
    expect((await shipping.checkServiceability("56001", "560102")).serviceable).toBe(false);
    expect((await shipping.checkServiceability("560001", "560102")).serviceable).toBe(true);
  });
});

describe("mock VisionProvider", () => {
  it("returns fixtures by image hash and a zero-confidence answer otherwise", async () => {
    const known = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" };
    const vision = createMockVisionProvider({
      [imageHash(known)]: { category: { categorySlug: "brake-discs", confidence: 0.93, modelVersion: "mock-vision-1" } },
    });
    expect((await vision.classifyCategory(known)).categorySlug).toBe("brake-discs");
    const unknown = await vision.classifyCategory({ bytes: new Uint8Array([9]), contentType: "image/jpeg" });
    expect(unknown).toMatchObject({ categorySlug: null, confidence: 0 });
  });
});

describe("memory StorageProvider", () => {
  it("round-trips objects and reports signed URL TTLs", async () => {
    const storage = createMemoryStorageProvider();
    await storage.put("listing-photos", "a/b.jpg", new Uint8Array([7]), "image/jpeg");
    expect(await storage.get("listing-photos", "a/b.jpg")).toEqual(new Uint8Array([7]));
    expect(await storage.createSignedDownloadUrl("listing-photos", "a/b.jpg")).toContain("ttl=600");
    await storage.delete("listing-photos", "a/b.jpg");
    expect(await storage.get("listing-photos", "a/b.jpg")).toBeNull();
  });
});

describe("mock NotificationProvider", () => {
  it("records each channel", async () => {
    const n = createMockNotificationProvider(silent);
    await n.sms({ userId: "u1", phone: "+910000000000", body: "Your part shipped" });
    await n.inApp({ userId: "u1", type: "order", title: "Shipped", body: "Your part shipped" });
    expect(n.sent.map((s) => s.channel)).toEqual(["SMS", "IN_APP"]);
  });
});
