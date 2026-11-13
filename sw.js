// Coach Claude — fonctionnement hors ligne.
// Réseau d'abord (pour avoir toujours la dernière version), cache en secours si pas de réseau
// ou si le réseau met plus de 2,5 s à répondre.
// Changer VERSION à chaque mise à jour de l'appli.
const VERSION = "coach-claude-v5";
const FILES = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const network = fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const cached = await cache.match(req, { ignoreSearch: true })
      || (req.mode === "navigate" ? await cache.match("./") : undefined);
    if (!cached) return network;
    const late = new Promise(r => setTimeout(() => r(cached), 2500));
    return Promise.race([network.catch(() => cached), late]);
  })());
});
