import { afterEach, describe, expect, it, vi } from "vitest";
import { CashfreeError, createCashfreeClient } from "@/server/adapters/payment/cashfree-client";
import { cashfreeCustomerId, cashfreeOrderId, cashfreePhone, createCashfreePaymentProvider, idempotencyUuid, paiseToRupees } from "@/server/adapters/payment/cashfree";
import { createMockPaymentProvider } from "@/server/adapters/payment/mock";
import type { SplitOrderInput } from "@/server/adapters/payment/types";

const SECRET = "cfsk_ma_test_SUPERSECRET_value_9876";
const APP_ID = "TEST-APP-ID-123";
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const input: SplitOrderInput = {
  orderId: "cmorder123",
  amount: 1_050_050, // ₹10,500.50
  vendorId: "",
  vendorShare: 970_000,
  customer: { id: "sample-user-buyer", phone: "+919876543210", name: "Asha Rao", email: "asha@example.com" },
  returnUrl: "http://localhost:3000/checkout/return?order=cmorder123",
  notifyUrl: "https://repart.example/api/webhooks/payments/cashfree",
  expiresAt: new Date("2026-10-01T10:00:00Z"),
  idempotencyKey: "order-key-1",
};
const cfOrder = { cf_order_id: "2149460581", order_id: "repart_cmorder123", order_status: "ACTIVE", order_amount: 10500.5, order_currency: "INR", payment_session_id: "session_abc123", order_expiry_time: "2026-10-01T15:30:00+05:30" };

function setup(response: () => Response | Promise<Response>) {
  const f = vi.fn(async () => response());
  const provider = createCashfreePaymentProvider(createCashfreeClient({ appId: APP_ID, secretKey: SECRET, env: "sandbox", fetch: f as unknown as typeof fetch }));
  const call = () => {
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
  };
  return { provider, call };
}

afterEach(() => vi.restoreAllMocks());

describe("Cashfree Create Order mapping (API 2026-01-01)", () => {
  it("POSTs /orders with order id, amount in rupees, INR, customer, return/notify URLs and expiry", async () => {
    const { provider, call } = setup(() => ok(cfOrder));
    await provider.createOrder(input);
    const { url, init, body } = call();
    expect(url).toBe("https://sandbox.cashfree.com/pg/orders");
    expect(init.method).toBe("POST");
    expect(body).toEqual({
      order_id: "repart_cmorder123",
      order_amount: 10500.5,
      order_currency: "INR",
      customer_details: { customer_id: "usampleuserbuyer", customer_phone: "9876543210", customer_name: "Asha Rao", customer_email: "asha@example.com" },
      order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
      order_expiry_time: "2026-10-01T10:00:00.000Z",
    });
  });

  it("omits notify_url unless it's https, and optional customer fields when missing", async () => {
    const { provider, call } = setup(() => ok(cfOrder));
    await provider.createOrder({ ...input, notifyUrl: "http://localhost:3000/hook", customer: { id: "u1", phone: "+919876543210", name: "Al", email: null }, expiresAt: undefined });
    const { body } = call();
    expect(body.order_meta).toEqual({ return_url: input.returnUrl });
    expect(body.customer_details).toEqual({ customer_id: "uu1", customer_phone: "9876543210" });
    expect(body).not.toHaveProperty("order_expiry_time");
  });

  it("sends a stable UUID idempotency key derived from RePart's key", async () => {
    const { provider, call } = setup(() => ok(cfOrder));
    await provider.createOrder(input);
    const key = call().headers["x-idempotency-key"];
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(key).toBe(idempotencyUuid("order-key-1"));
    expect(idempotencyUuid("order-key-2")).not.toBe(key);
  });

  it("validates identifiers and amounts before calling Cashfree", () => {
    expect(cashfreeOrderId("abc.def")).toBe("repart_abc_def");
    expect(() => cashfreeOrderId("x".repeat(40))).toThrow(/too long/);
    expect(cashfreeCustomerId("sample-user-buyer")).toBe("usampleuserbuyer");
    expect(cashfreePhone("+919876543210")).toBe("9876543210");
    expect(paiseToRupees(12345)).toBe(123.45);
    expect(() => paiseToRupees(99)).toThrow(/at least ₹1/);
    expect(() => paiseToRupees(100.5)).toThrow(/whole paise/);
  });
});

describe("Cashfree Create Order responses", () => {
  it("returns only what checkout needs: provider order id, status, amount and the payment session id", async () => {
    const { provider } = setup(() => ok(cfOrder));
    const order = await provider.createOrder(input);
    expect(order).toEqual({ providerOrderId: "2149460581", status: "CREATED", checkoutUrl: null, paymentSessionId: "session_abc123", amount: 1_050_050 });
    expect(JSON.stringify(order)).not.toMatch(new RegExp(`${SECRET}|${APP_ID}`));
  });

  it("surfaces a Cashfree API error without the credentials", async () => {
    const { provider } = setup(() => ok({ message: `order_id already exists (${SECRET})`, code: "order_already_exists", type: "invalid_request_error" }, 409));
    const err = await provider.createOrder(input).catch((e) => e);
    expect(err).toBeInstanceOf(CashfreeError);
    expect(err).toMatchObject({ status: 409, code: "order_already_exists" });
    expect(JSON.stringify([err.message, err.stack])).not.toContain(SECRET);
  });

  it("rejects a malformed success response", async () => {
    const { provider } = setup(() => ok({ order_status: "WEIRD" }));
    await expect(provider.createOrder(input)).rejects.toThrow(/expected fields/);
  });

  it("rejects unsigned webhooks instead of throwing", () => {
    const { provider } = setup(() => ok(cfOrder));
    expect(provider.verifyWebhook("{}", new Headers())).toBe(false);
  });
});

describe("mock PaymentProvider is unchanged", () => {
  it("still creates an idempotent order with a checkout URL and no session id", async () => {
    const mock = createMockPaymentProvider({ webhookSecret: "test-secret-0123456789", baseUrl: "http://localhost:3000" });
    const a = await mock.createOrder(input);
    expect(a).toMatchObject({ providerOrderId: "mock_order_cmorder123", status: "CREATED", checkoutUrl: "http://localhost:3000/dev/mock-checkout/cmorder123", paymentSessionId: null, amount: 1_050_050 });
    expect((await mock.createOrder(input)).providerOrderId).toBe(a.providerOrderId);
  });
});

describe("provider selection from PAYMENT_PROVIDER", { timeout: 30_000 }, () => { // cold re-import of the adapter graph is slow under full-suite load
  const base = { APP_BASE_URL: "http://localhost:3000", STORAGE_PROVIDER: "memory", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", CASHFREE_ENV: "sandbox" };
  async function adaptersWith(e: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("@/server/env", () => ({ env: () => e }));
    return (await import("@/server/adapters")).adapters();
  }

  it("uses the mock by default", async () => {
    expect((await adaptersWith({ ...base, PAYMENT_PROVIDER: "mock" })).payment.name).toBe("mock");
  });

  it("uses Cashfree only when PAYMENT_PROVIDER=cashfree", async () => {
    expect((await adaptersWith({ ...base, PAYMENT_PROVIDER: "cashfree", CASHFREE_APP_ID: APP_ID, CASHFREE_SECRET_KEY: SECRET })).payment.name).toBe("cashfree");
  });
});
