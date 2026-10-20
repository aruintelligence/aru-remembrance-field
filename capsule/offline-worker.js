// An opt-in offline copy of the reader code. Never cache user content or requests
// outside this exact, versioned app shell.
const CACHE_NAME = "aru-capsule-reader-a96d7bb5d50342ecf8ffe9ca7c2c439f300138403811df5af8e66fe49e79ee98";
const SHELL = [
  "./",
  "./app.mjs?v=39016898cf4e5f65a2852449b3379a55c4b05691aa40c503811ecee9dbf85837",
  "./core.mjs?v=c4b5f7c607450d1ce71a7e55d1fc98d0756988fe58d124be3124b716187ca622"
];
const DIGESTS = ["515ae4c1934a4e673bea07ee7055eff487d1414f5203184d1ce22b3292b84158", "39016898cf4e5f65a2852449b3379a55c4b05691aa40c503811ecee9dbf85837", "c4b5f7c607450d1ce71a7e55d1fc98d0756988fe58d124be3124b716187ca622"];
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
