import "server-only";
import type { OtpProvider } from "./types";

export const MOCK_OTP_CODE = "000000";

/** Dev/test OTP: every code is 000000. Rate limiting and attempt counting live in the auth service (M2). */
export function createMockOtpProvider(log: (msg: string) => void = console.info): OtpProvider {
  return {
    name: "mock",
    async send(phone) {
      log(`[mock otp] code for ${phone.slice(0, 3)}******${phone.slice(-2)} is ${MOCK_OTP_CODE}`);
      return { sent: true, expiresInSeconds: 300 };
    },
    async verify(_phone, code) {
      return { valid: code === MOCK_OTP_CODE };
    },
  };
}
