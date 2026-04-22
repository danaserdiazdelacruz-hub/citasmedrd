// sw.js — Service Worker para CitasMed Pro (PWA)
// Estrategia: network-first para API, cache-first para estáticos.
// Evita cachear respuestas de /api/ (datos críticos siempre frescos).

const CACHE_NAME = 'citasmed-v1';
const OFFLINE_URL = '/dashboard/';

// Recursos estáticos a cachear al instalar
const STATIC_ASSETS = [
  '/dashboard/',
  '/dashboard/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  // Fuentes externas también se pueden cachear
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'
];

// INSTALL: cachea estáticos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {
        // Si alguno falla, continuar
        console.warn('[SW] Algunos recursos no se cachearon');
      }))
      .then(() => self.skipWaiting())
  );
});

// ACTIVATE: limpia caches viejos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

// FETCH: estrategia según tipo de recurso
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo GET
  if (req.method !== 'GET') return;

  // API: nunca cachear, network-only con fallback a error claro
  if (url.pathname.includes('/api/') || url.hostname.includes('railway.app')) {
    event.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ error: 'offline', message: 'Sin conexión a internet' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // Estáticos: cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // Cachear solo respuestas exitosas
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const respClone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, respClone));
        }
        return resp;
      }).catch(() => {
        // Si es navegación y offline, servir la página cacheada
        if (req.mode === 'navigate') {
          return caches.match(OFFLINE_URL);
        }
      });
    })
  );
});
