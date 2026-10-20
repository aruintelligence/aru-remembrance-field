// An opt-in offline copy of the reader code. Never cache user content or requests
// outside this exact, versioned app shell.
const CACHE_NAME = "aru-capsule-reader-5ba4cf6cca48e63064bb67400d5782e5d8646700ae6bea0c55b73d9a5255d55e";
const SHELL = [
  "./",
  "./app.mjs?v=d63f3cfcfa13ba72c4962f1acc8bed91b6539f08cd0b532eca66e549b0a23950",
  "./core.mjs?v=b553142ea50ac023405ff9391b58e275c80641438202256283e730c91b0dd0fc"
];
const DIGESTS = ["d72bfe744cead5306808fbf0d99a554904e4120bc54e62e4e7defa8e1781b26a", "d63f3cfcfa13ba72c4962f1acc8bed91b6539f08cd0b532eca66e549b0a23950", "b553142ea50ac023405ff9391b58e275c80641438202256283e730c91b0dd0fc"];
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
