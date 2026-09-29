import "server-only";
import { Client } from "minio";
import { DEFAULT_DOWNLOAD_TTL_SECONDS, DEFAULT_UPLOAD_TTL_SECONDS, type StorageProvider } from "./types";

/** MinIO (S3-compatible) for offline development via docker compose. */
export function createMinioStorageProvider(opts: { endpoint: string; accessKey: string; secretKey: string }): StorageProvider {
  const u = new URL(opts.endpoint);
  const client = new Client({
    endPoint: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    useSSL: u.protocol === "https:",
    accessKey: opts.accessKey,
    secretKey: opts.secretKey,
  });

  return {
    name: "minio",
    async createSignedUploadUrl(bucket, key, expiresInSeconds = DEFAULT_UPLOAD_TTL_SECONDS) {
      return { url: await client.presignedPutObject(bucket, key, expiresInSeconds), key, expiresInSeconds };
    },
    async createSignedDownloadUrl(bucket, key, expiresInSeconds = DEFAULT_DOWNLOAD_TTL_SECONDS) {
      return client.presignedGetObject(bucket, key, expiresInSeconds);
    },
    async get(bucket, key) {
      try {
        const stream = await client.getObject(bucket, key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return new Uint8Array(Buffer.concat(chunks));
      } catch {
        return null;
      }
    },
    async put(bucket, key, body, contentType) {
      await client.putObject(bucket, key, Buffer.from(body), body.byteLength, { "Content-Type": contentType });
    },
    async delete(bucket, key) {
      await client.removeObject(bucket, key);
    },
    async ping() {
      await client.listBuckets();
    },
  };
}
