/*
 * RePart service worker (PLAN.md §1.2 "PWA"): app shell and last-viewed pages cached, an /offline fallback.
 * No offline writes: only GET requests are ever answered from cache.
 *
 * What is never cached: API routes, server-action and RSC requests, anything cross-origin (including signed photo
 * URLs, which expire after 10 minutes), and pages in signed-in areas (account, orders, messages, selling, garage,
 * checkout, mechanic, admin, sign-in).
 */
const VERSION = "repart-v2";
const SHELL = `${VERSION}-shell`;
const PAGES = `${VERSION}-pages`;
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];
const MAX_PAGES = 25;
const PUBLIC_PAGE = /^\/(|search|listings\/[^/]+|parts\/[^/]+|sellers\/[^/]+|how-it-works|help|privacy|terms)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(`${VERSION}-`)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimPages() {
  const cache = await caches.open(PAGES);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_PAGES)).map((k) => cache.delete(k)));
}

/** Cached pages belong to whoever was signed in when they were fetched; a change of session empties the cache. */
async function checkSession(response) {
  const now = response.headers.get("X-Repart-Session");
  if (now === null) return;
  const meta = await caches.open(SHELL);
  const prev = await meta.match("/__session");
  if (prev && (await prev.text()) === now) return;
  await caches.delete(PAGES);
  await meta.put("/__session", new Response(now));
}

/** Network first; a successful public page is kept so it can be read offline later. */
async function navigate(request) {
  const url = new URL(request.url);
  try {
    const response = await fetch(request);
    await checkSession(response);
    if (response.ok && response.type === "basic" && PUBLIC_PAGE.test(url.pathname)) {
      const cache = await caches.open(PAGES);
      await cache.put(url.pathname + url.search, response.clone());
      void trimPages();
    }
    return response;
  } catch {
    const cached = PUBLIC_PAGE.test(url.pathname) ? await caches.match(url.pathname + url.search, { cacheName: PAGES }) : undefined;
    return cached ?? (await caches.match(OFFLINE_URL)) ?? Response.error();
  }
}

/** Build assets have content hashes in their names, so a cached copy is always correct. */
async function shellAsset(request) {
  const cached = await caches.match(request, { cacheName: SHELL });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(SHELL)).put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") return event.respondWith(navigate(request));
  if (url.pathname.startsWith("/_next/static/")) return event.respondWith(shellAsset(request));
  if (PRECACHE.includes(url.pathname)) return event.respondWith(caches.match(request).then((r) => r ?? fetch(request)));
});
