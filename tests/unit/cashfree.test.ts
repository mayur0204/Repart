import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASHFREE_API_VERSION, CashfreeError, cashfreeHeaders, createCashfreeClient } from "@/server/adapters/payment/cashfree-client";
import { logger } from "@/server/logger";

const APP_ID = "TEST-APP-ID-123";
const SECRET = "cfsk_ma_test_SUPERSECRET_value_9876";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (fetchImpl: typeof fetch, timeoutMs?: number) => createCashfreeClient({ appId: APP_ID, secretKey: SECRET, env: "sandbox", fetch: fetchImpl, timeoutMs });

afterEach(() => vi.restoreAllMocks());

describe("Cashfree client: sandbox configuration", () => {
  it("talks only to the sandbox base URL with the documented API version", async () => {
    const f = vi.fn(async () => json(200, { cf_order_id: "1", order_id: "o1", order_status: "ACTIVE", order_amount: 10, order_currency: "INR" }));
    await client(f as unknown as typeof fetch).getOrder("o 1");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox.cashfree.com/pg/orders/o%201");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["x-api-version"]).toBe("2026-01-01");
    expect(CASHFREE_API_VERSION).toBe("2026-01-01");
  });

  it("refuses to start without credentials or outside the sandbox", () => {
    expect(() => createCashfreeClient({ appId: "", secretKey: SECRET, env: "sandbox" })).toThrow(/not configured/);
    expect(() => createCashfreeClient({ appId: APP_ID, secretKey: SECRET, env: "production" as never })).toThrow(/Only the Cashfree sandbox/);
  });
});

describe("Cashfree client: authentication headers", () => {
  it("sends x-client-id / x-client-secret / x-api-version and an optional idempotency key", () => {
    const h = cashfreeHeaders({ appId: APP_ID, secretKey: SECRET }, { requestId: "r1", idempotencyKey: "k1" });
    expect(h).toMatchObject({ "x-client-id": APP_ID, "x-client-secret": SECRET, "x-api-version": CASHFREE_API_VERSION, "x-request-id": "r1", "x-idempotency-key": "k1" });
    expect(cashfreeHeaders({ appId: APP_ID, secretKey: SECRET }, { requestId: "r2" })).not.toHaveProperty("x-idempotency-key");
  });
});

describe("Cashfree client: responses", () => {
  it("returns the parsed body on success", async () => {
    const order = { cf_order_id: "2149460581", order_id: "order_1", order_status: "ACTIVE", order_amount: 10.5, order_currency: "INR" };
    await expect(client((async () => json(200, order)) as unknown as typeof fetch).getOrder("order_1")).resolves.toEqual(order);
  });

  it("turns a documented error body into a CashfreeError with status, code and type", async () => {
    const err = await client((async () => json(404, { message: "order not found", code: "order_not_found", type: "invalid_request_error" })) as unknown as typeof fetch)
      .getOrder("missing")
      .catch((e) => e);
    expect(err).toBeInstanceOf(CashfreeError);
    expect(err).toMatchObject({ status: 404, code: "order_not_found", type: "invalid_request_error", message: "order not found" });
  });

  it("handles non-JSON error bodies", async () => {
    const err = await client((async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch).getOrder("x").catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "http_502" });
  });

  it("maps a timeout and a network failure to clear errors", async () => {
    const slow = ((_: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(client(slow, 20).getOrder("x")).rejects.toMatchObject({ code: "timeout", status: null });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(client(down).getOrder("x")).rejects.toMatchObject({ code: "network_error", status: null });
  });
});

describe("Cashfree client: secrets never leak", () => {
  it("never puts the app id or secret into logs or error messages, even if Cashfree echoes them", async () => {
    const warn = vi.spyOn(logger, "warn");
    const echo = (async () => json(401, { message: `authentication failed for ${APP_ID} / ${SECRET}`, code: "request_failed", type: "authentication_error" })) as unknown as typeof fetch;
    const err = await client(echo).getOrder("x").catch((e) => e);
    const surfaces = JSON.stringify([err.message, err.stack, { ...err }, warn.mock.calls]);
    expect(surfaces).not.toContain(SECRET);
    expect(surfaces).not.toContain(APP_ID);
    expect(err.message).toBe("authentication failed for [redacted] / [redacted]");
    expect(warn).toHaveBeenCalled();
  });
});

describe("Cashfree client: server-only boundary", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  it("is a server-only module", () => {
    expect(readFileSync(join(root, "src/server/adapters/payment/cashfree-client.ts"), "utf8").startsWith('import "server-only";')).toBe(true);
  });
  it("no client component or app/** file imports it directly", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = join(dir, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.tsx?$/.test(n)) {
          const src = readFileSync(f, "utf8");
          if (/cashfree-client/.test(src) && (src.trimStart().startsWith('"use client"') || f.includes(`${join(root, "app")}`))) hits.push(f);
        }
      }
    };
    walk(join(root, "app"));
    walk(join(root, "src"));
    expect(hits).toEqual([]);
  });
});
