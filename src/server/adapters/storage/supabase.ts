import "server-only";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_DOWNLOAD_TTL_SECONDS, DEFAULT_UPLOAD_TTL_SECONDS, type StorageProvider } from "./types";

/**
 * Supabase Storage, server-side only with the service-role key (REPART_BRIEF.md §2).
 * The only place @supabase/supabase-js is used; never for data access.
 * The client is created lazily so importing this module makes no network calls.
 */
export function createSupabaseStorageProvider(opts: { url: string; serviceRoleKey: string }): StorageProvider {
  let client: ReturnType<typeof createClient> | undefined;
  const storage = () => {
    client ??= createClient(opts.url, opts.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    return client.storage;
  };
  const fail = (op: string, error: { message: string }) => new Error(`supabase storage ${op} failed: ${error.message}`);

  return {
    name: "supabase",
    async createSignedUploadUrl(bucket, key, expiresInSeconds = DEFAULT_UPLOAD_TTL_SECONDS) {
      // Supabase fixes upload-URL validity server-side; expiresInSeconds is reported for the caller's UI.
      const { data, error } = await storage().from(bucket).createSignedUploadUrl(key);
      if (error) throw fail("createSignedUploadUrl", error);
      return { url: data.signedUrl, key: data.path, token: data.token, expiresInSeconds };
    },
    async createSignedDownloadUrl(bucket, key, expiresInSeconds = DEFAULT_DOWNLOAD_TTL_SECONDS) {
      const { data, error } = await storage().from(bucket).createSignedUrl(key, expiresInSeconds);
      if (error) throw fail("createSignedUrl", error);
      return data.signedUrl;
    },
    async get(bucket, key) {
      const { data, error } = await storage().from(bucket).download(key);
      if (error) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async put(bucket, key, body, contentType) {
      const { error } = await storage().from(bucket).upload(key, body, { contentType, upsert: true });
      if (error) throw fail("upload", error);
    },
    async delete(bucket, key) {
      const { error } = await storage().from(bucket).remove([key]);
      if (error) throw fail("remove", error);
    },
    async ping() {
      const { error } = await storage().listBuckets();
      if (error) throw fail("ping", error);
    },
  };
}
