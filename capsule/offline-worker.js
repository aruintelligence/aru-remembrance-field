// An opt-in offline copy of the reader code. Never cache user content or requests
// outside this exact, versioned app shell. Online navigations check for a fresh
// release; the digest-verified copy is a fallback when the network is unavailable.
const CACHE_NAME = "aru-capsule-reader-553fdda11a54ddfd28befec3b9276d071acbc75de514ac7fcda2c7ad4eded327";
const SHELL = [
  "./",
  "./app.mjs?v=91961e35457b403493a2364d660f04260f09ddf69420c6eafeae264de0e35235",
  "./core.mjs?v=3a2739f8b636f7d9f812eeaf3ce39ea86a11886f80a3430c789f2f43be1d05bb"
];
const DIGESTS = ["f5bfe81a753393f207446e36d65e9d66f73b49f660df02dd2e6502ebf48ee2f1", "91961e35457b403493a2364d660f04260f09ddf69420c6eafeae264de0e35235", "3a2739f8b636f7d9f812eeaf3ce39ea86a11886f80a3430c789f2f43be1d05bb"];
const PREFIX = "aru-capsule-reader-";
const absolute = path => new URL(path, self.registration.scope).href;

async function verify(cache) {
  for (let index = 0; index < SHELL.length; index++) {
    const response = await cache.match(absolute(SHELL[index]));
    if (!response?.ok) throw Error("Missing offline reader asset");
    const bytes = await response.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== DIGESTS[index]) throw Error("Offline reader assets did not match this release");
  }
}

self.addEventListener("message", event => {
  if (event.data?.type !== "aru-capsule-reader-verify" || !event.ports?.[0]) return;
  const reply = event.ports[0];
  event.waitUntil((async () => {
    try {
      await verify(await caches.open(CACHE_NAME));
      reply.postMessage({ ok: true, htmlDigest: DIGESTS[0], appUrl: absolute(SHELL[1]) });
    } catch {
      reply.postMessage({ ok: false });
    }
  })());
});

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL.map(path => new Request(absolute(path), { cache: "reload" })));
      await verify(cache);
      await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const home = absolute("./");
  const isReader = request.mode === "navigate" &&
    (url.href === home || url.href === absolute("./index.html"));
  const isModule = request.destination === "script" && SHELL.slice(1)
    .some(path => url.href === absolute(path));
  if (!isReader && !isModule) return;
  event.respondWith((async () => {
    if (isReader) {
      let networkResponse;
      try {
        networkResponse = await fetch(request, { cache: "reload" });
        if (networkResponse.ok) return networkResponse;
      } catch { /* The verified reader can still open without a connection. */ }
      const cached = await (await caches.open(CACHE_NAME)).match(home);
      return cached || networkResponse || fetch(request);
    }
    const cached = await (await caches.open(CACHE_NAME)).match(request);
    return cached || fetch(request);
  })());
});
