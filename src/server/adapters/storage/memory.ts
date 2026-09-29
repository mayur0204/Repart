import "server-only";
import { DEFAULT_DOWNLOAD_TTL_SECONDS, DEFAULT_UPLOAD_TTL_SECONDS, type StorageProvider } from "./types";

type StoredObject = { body: Uint8Array; contentType: string };

/** In-memory storage for unit tests. Signed URLs are fake but carry the TTL for assertions. */
export function createMemoryStorageProvider(): StorageProvider & { readonly objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  const id = (bucket: string, key: string) => `${bucket}/${key}`;
  return {
    name: "memory",
    objects,
    async createSignedUploadUrl(bucket, key, expiresInSeconds = DEFAULT_UPLOAD_TTL_SECONDS) {
      return { url: `memory://upload/${id(bucket, key)}?ttl=${expiresInSeconds}`, key, expiresInSeconds };
    },
    async createSignedDownloadUrl(bucket, key, expiresInSeconds = DEFAULT_DOWNLOAD_TTL_SECONDS) {
      return `memory://download/${id(bucket, key)}?ttl=${expiresInSeconds}`;
    },
    async get(bucket, key) {
      return objects.get(id(bucket, key))?.body ?? null;
    },
    async put(bucket, key, body, contentType) {
      objects.set(id(bucket, key), { body, contentType });
    },
    async delete(bucket, key) {
      objects.delete(id(bucket, key));
    },
    async ping() {},
  };
}
