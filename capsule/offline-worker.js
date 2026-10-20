// An opt-in offline copy of the reader code. Never cache user content or requests
// outside this exact, versioned app shell. Online navigations check for a fresh
// release; the digest-verified copy is a fallback when the network is unavailable.
const CACHE_NAME = "aru-capsule-reader-85fb322cd5aceb45a38eb469cde3f5c38382c94bd6802239aaa2f4f54bdb372c";
const SHELL = [
  "./",
  "./app.mjs?v=1e64f5b8dc36ab7a47e4a54ee608b34eda8daf28c37b339982d30760dbaa9bf6",
  "./core.mjs?v=0d9f6b791080ef2272e80f318eaef7e8cb920552bf9a5cea60475e70477bae65"
];
const DIGESTS = ["aa21d807da5fb5d5033b2892307dd9370d73504bf843213551534a53bb72f289", "1e64f5b8dc36ab7a47e4a54ee608b34eda8daf28c37b339982d30760dbaa9bf6", "0d9f6b791080ef2272e80f318eaef7e8cb920552bf9a5cea60475e70477bae65"];
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
