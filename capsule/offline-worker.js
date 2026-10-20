// An opt-in offline copy of the reader code. Never cache user content or requests
// outside this exact, versioned app shell.
const CACHE_NAME = "aru-capsule-reader-2be953393a07e5c86de910915afa650c9bda58b4a2f0b5121182f0498cec3ad2";
const SHELL = [
  "./",
  "./app.mjs?v=9db0d172d545ddfacb6a5080399f665c0e0387ffb5d9eda17790f27d0f41517c",
  "./core.mjs?v=d3b7918deb9e126592791d94ec9759cdcea504abbba5c4614dc8f73495aa82df"
];
const DIGESTS = ["cbe1ca781e0a262c4d5f6f7b74e905de607bf5f8aa27a78e2bd423f742ceea20", "9db0d172d545ddfacb6a5080399f665c0e0387ffb5d9eda17790f27d0f41517c", "d3b7918deb9e126592791d94ec9759cdcea504abbba5c4614dc8f73495aa82df"];
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
    const cached = await (await caches.open(CACHE_NAME)).match(isReader ? home : request);
    return cached || fetch(request);
  })());
});
