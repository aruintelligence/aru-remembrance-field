// An opt-in offline copy of the reader code. Never cache user content or requests
// outside this exact, versioned app shell.
const CACHE_NAME = "aru-capsule-reader-4930b4e08e4f2689d908136514bbcfd283fca671d506471d594cd766d4d2b0cd";
const SHELL = [
  "./",
  "./app.mjs?v=d84c2ef0a1d78adfdc51fa7ee60d897cf87c51924cc4738ee67c0861576f3796",
  "./core.mjs?v=c4b5f7c607450d1ce71a7e55d1fc98d0756988fe58d124be3124b716187ca622"
];
const DIGESTS = ["f7bc41569010098eb4712841c68456c6433e65aa9cf6824ad6b9acdda87b75e5", "d84c2ef0a1d78adfdc51fa7ee60d897cf87c51924cc4738ee67c0861576f3796", "c4b5f7c607450d1ce71a7e55d1fc98d0756988fe58d124be3124b716187ca622"];
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
