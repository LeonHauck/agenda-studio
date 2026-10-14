// Service worker do painel: permite instalar como app no celular.
// "Rede primeiro": sempre busca a versão mais nova; usa o cache só sem internet.
// Requisições ao Supabase (outro domínio) não passam por aqui.
const CACHE = 'agenda-admin-v17';
const ASSETS = ['./', './index.html', '../css/styles.css', '../js/config.js', '../js/core.js', '../js/api.js', '../js/admin.js', '../icons/icon.svg', '../icons/icon-192.png'];

self.addEventListener('install', e => {
  // Se algum arquivo não baixar agora, o app instala do mesmo jeito (ele busca depois)
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Notificação enviada pela Edge Function "notify"
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Agenda', {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '../icons/icon-192.png',
    badge: '../icons/icon-192.png',
    data: { url: self.registration.scope + '#agenda' },
  }));
});

// Tocar na notificação abre (ou traz para frente) o painel
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(e.notification.data.url);
  }));
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
