// オフラインでも起動できるよう、アプリのファイルをブラウザに保存しておく。
// 通信できるときは毎回新しいファイルを取りに行き（更新がすぐ反映される）、取れないときだけ保存しておいたものを使う。
// 利用者のデータ（IndexedDB）やファイル・YouTube の通信には関わらない
const CACHE = 'cells-player-v2';

// 新しいファイルを足したら、ここにも足す
const APP_FILES = [
  './',
  './index.html',
  './privacy.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/broadcast.js',
  './js/share.js',
  './js/commentlist.js',
  './js/db.js',
  './js/digest.js',
  './js/i18n.js',
  './js/i18n-en.js',
  './js/live.js',
  './js/moment.js',
  './js/players.js',
  './js/practice.js',
  './js/presets.js',
  './js/sidebar.js',
  './js/store.js',
  './js/timeline.js',
  './js/transcript.js',
  './js/txtools.js',
  './js/util.js',
  './js/words.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(APP_FILES.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cells-player-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// アプリ自体のファイルだけ保存する（同じサイトに置いた動画などは保存しない）
const APP_PATH = /(\/|\.html|\.css|\.js|\.svg|\.png|\.webmanifest)$/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // このサイトのアプリのファイルだけ扱う（YouTube・動画の途中からの読み込みなどはそのまま通す）
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('range')) return;
  if (req.mode !== 'navigate' && !APP_PATH.test(url.pathname)) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          // ?src=… などの付いた URL も、同じファイルとして1つだけ保存する
          caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
        return Response.error();
      }),
  );
});
