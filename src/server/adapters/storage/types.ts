export type Bucket = string;

export type SignedUpload = { url: string; key: string; token?: string; expiresInSeconds: number };

/** Private object storage. Files are only ever served through short-lived signed URLs (PLAN.md §1.2). */
export interface StorageProvider {
  readonly name: string;
  createSignedUploadUrl(bucket: Bucket, key: string, expiresInSeconds?: number): Promise<SignedUpload>;
  createSignedDownloadUrl(bucket: Bucket, key: string, expiresInSeconds?: number): Promise<string>;
  get(bucket: Bucket, key: string): Promise<Uint8Array | null>;
  put(bucket: Bucket, key: string, body: Uint8Array, contentType: string): Promise<void>;
  delete(bucket: Bucket, key: string): Promise<void>;
  /** Cheap reachability check for /api/health. */
  ping(): Promise<void>;
}

export const DEFAULT_UPLOAD_TTL_SECONDS = 300;
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 600;
