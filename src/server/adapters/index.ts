import "server-only";
import { env } from "../env";
import { createMockNotificationProvider } from "./notification/mock";
import type { NotificationProvider } from "./notification/types";
import { createMockOtpProvider } from "./otp/mock";
import type { OtpProvider } from "./otp/types";
import { createCashfreePaymentProvider } from "./payment/cashfree";
import { cashfreeFromEnv } from "./payment/cashfree-client";
import { createMockPaymentProvider } from "./payment/mock";
import type { PaymentProvider } from "./payment/types";
import { createMockShippingProvider } from "./shipping/mock";
import type { ShippingProvider } from "./shipping/types";
import { createMemoryStorageProvider } from "./storage/memory";
import { createMinioStorageProvider } from "./storage/minio";
import { createSupabaseStorageProvider } from "./storage/supabase";
import type { StorageProvider } from "./storage/types";
import { createMockVisionProvider } from "./vision/mock";
import type { VisionProvider } from "./vision/types";

export type Adapters = {
  otp: OtpProvider;
  payment: PaymentProvider;
  shipping: ShippingProvider;
  vision: VisionProvider;
  storage: StorageProvider;
  notification: NotificationProvider;
};

// Dev-only fallback so mocks work before MOCK_WEBHOOK_SECRET is set; env-schema refuses mock payments in production.
const DEV_WEBHOOK_SECRET = "dev-only-mock-webhook-secret";

function createStorage(): StorageProvider {
  const e = env();
  switch (e.STORAGE_PROVIDER) {
    case "memory":
      return createMemoryStorageProvider();
    case "minio":
      if (!e.MINIO_ENDPOINT || !e.MINIO_ACCESS_KEY || !e.MINIO_SECRET_KEY) {
        throw new Error("STORAGE_PROVIDER=minio needs MINIO_ENDPOINT, MINIO_ACCESS_KEY and MINIO_SECRET_KEY");
      }
      return createMinioStorageProvider({ endpoint: e.MINIO_ENDPOINT, accessKey: e.MINIO_ACCESS_KEY, secretKey: e.MINIO_SECRET_KEY });
    case "supabase":
      return createSupabaseStorageProvider({ url: e.SUPABASE_URL, serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY });
  }
}

let cached: Adapters | undefined;

/** Adapter implementations selected from env (PLAN.md §1.3). Built once per process. */
export function adapters(): Adapters {
  if (cached) return cached;
  const e = env();
  const webhookSecret = e.MOCK_WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET;
  cached = {
    otp: createMockOtpProvider(),
    payment: e.PAYMENT_PROVIDER === "cashfree" ? createCashfreePaymentProvider(cashfreeFromEnv()) : createMockPaymentProvider({ webhookSecret, baseUrl: e.APP_BASE_URL }),
    shipping: createMockShippingProvider({ webhookSecret: e.SHIPPING_WEBHOOK_SECRET ?? webhookSecret }),
    vision: createMockVisionProvider(),
    storage: createStorage(),
    notification: createMockNotificationProvider(),
  };
  return cached;
}
