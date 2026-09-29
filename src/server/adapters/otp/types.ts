export type OtpSendResult = { sent: true; expiresInSeconds: number };
export type OtpVerifyResult = { valid: boolean };

/** Phone OTP delivery and verification (REPART_BRIEF.md §3). Phones are E.164 (+91...). */
export interface OtpProvider {
  readonly name: string;
  send(phone: string): Promise<OtpSendResult>;
  verify(phone: string, code: string): Promise<OtpVerifyResult>;
}
