// Service worker do painel: permite instalar como app no celular.
// "Rede primeiro": sempre busca a versão mais nova; usa o cache só sem internet.
// Requisições ao Supabase (outro domínio) não passam por aqui.
const CACHE = 'agenda-admin-v7';
const ASSETS = ['./', './index.html', '../css/styles.css', '../js/config.js', '../js/core.js', '../js/api.js', '../js/admin.js', '../icons/icon.svg', '../icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
