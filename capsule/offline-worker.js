// An opt-in offline copy of the reader code. Never cache user content or requests
// outside this exact, versioned app shell. Online navigations check for a fresh
// release; the digest-verified copy is a fallback when the network is unavailable.
const CACHE_NAME = "aru-capsule-reader-35d1e72ab9b424137925f9d9eb235e2e9ebbb40b6f84c577c94606ea5968c447";
const SHELL = [
  "./",
  "./app.mjs?v=1ddfdb3e0d636d5c1c365c96584c2ed755e51e43db6adad99bdd514f08b45b6e",
  "./core.mjs?v=0d9f6b791080ef2272e80f318eaef7e8cb920552bf9a5cea60475e70477bae65"
];
const DIGESTS = ["9f1d2374f26ad3c17db32c5bbed6050bfd935285dc58aefae1232f4a50f07ebb", "1ddfdb3e0d636d5c1c365c96584c2ed755e51e43db6adad99bdd514f08b45b6e", "0d9f6b791080ef2272e80f318eaef7e8cb920552bf9a5cea60475e70477bae65"];
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
