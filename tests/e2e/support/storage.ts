import { expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { withDb } from "./db";
import { BUCKETS, devStorageConfig } from "./env";

/** Service-role client for the development project, used by the test runner only (never sent to a browser). */
export function devStorage() {
  const { url, serviceRoleKey } = devStorageConfig();
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }).storage;
}

/**
 * Deletes every object the run's test database points at: processed and unprocessed listing photos, inspection photos
 * and dispute evidence. The test database is recreated per run and the seed has no files, so these keys can only
 * belong to this run; nothing else in the development buckets is touched.
 */
export async function removeRunObjects(): Promise<{ removed: number }> {
  const keys = await withDb(async (c) => {
    const q = async (table: string) =>
      (await c.query<{ k: string }>(`SELECT unnest(ARRAY["storageKey", "incomingKey"]) AS k FROM "${table}"`)).rows.map((r) => r.k).filter(Boolean);
    return { [BUCKETS.listing]: await q("ListingPhoto"), [BUCKETS.inspection]: await q("InspectionPhoto"), [BUCKETS.dispute]: await q("DisputeEvidence") };
  });
  const storage = devStorage();
  let removed = 0;
  for (const [bucket, list] of Object.entries(keys)) {
    for (let i = 0; i < list.length; i += 100) {
      const { data, error } = await storage.from(bucket).remove(list.slice(i, i + 100));
      if (error) throw new Error(`cleanup of ${bucket} failed: ${error.message}`);
      removed += data?.length ?? 0;
    }
  }
  return { removed };
}

/**
 * A photo URL shown to a user must be a short-lived signed URL for a private bucket: it loads, its token expires 10
 * minutes after issue, the same object without a signature is refused, and no credential appears in the URL.
 */
export async function expectSignedPrivateImage(request: APIRequestContext, signedUrl: string, bucket: string) {
  const { url: base, serviceRoleKey } = devStorageConfig();
  const u = new URL(signedUrl);
  expect(u.origin).toBe(new URL(base).origin);
  expect(u.pathname).toContain(`/storage/v1/object/sign/${bucket}/`);
  expect(signedUrl.includes(serviceRoleKey)).toBe(false);
  const token = u.searchParams.get("token")!;
  const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { exp: number; iat: number };
  expect(claims.exp - claims.iat).toBe(600);

  const signed = await request.get(signedUrl);
  expect(signed.status()).toBe(200);
  expect(signed.headers()["content-type"]).toBe("image/jpeg");

  const key = u.pathname.split(`/object/sign/${bucket}/`)[1]!;
  const publicUrl = `${u.origin}/storage/v1/object/public/${bucket}/${key}`;
  expect((await request.get(publicUrl)).status(), "public URL must be refused").toBeGreaterThanOrEqual(400);
  expect((await request.get(`${u.origin}/storage/v1/object/${bucket}/${key}`)).status(), "unsigned URL must be refused").toBeGreaterThanOrEqual(400);
}
