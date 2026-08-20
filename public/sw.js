/*
 * デジタルワードローブ Service Worker
 *
 * 【重要】activate では自アプリ以外のキャッシュを削除しない。
 *   旧配信元の gigayama.github.io は数十個のアプリが同一オリジンを共有していた。
 *   同居する配置に戻したときに他アプリを巻き込まないよう、
 *   CACHE_PREFIX で始まるキャッシュだけを掃除する。
 *   caches.keys() を全消しすると、他のアプリがオフラインで起動しなくなる。
 *
 * Service Worker は localStorage を一切操作しない（そもそも触れない）。
 *
 * ⚠️ このファイルの APP_VERSION と PRECACHE_URLS は
 *    tools/build-sw.mjs がビルド時に実バイトから書き換える。
 *    ここに書いてある値は開発中に読み込んだときの控えである。
 *    Vite の出力するファイル名にはハッシュが付くので、手で並べても必ず古くなる。
 */
const CACHE_PREFIX = 'digital-closet-';
const APP_VERSION = 'dev'; /* __APP_VERSION__ */
const CACHE_STATIC = CACHE_PREFIX + 'static-' + APP_VERSION;
const CACHE_RUNTIME = CACHE_PREFIX + 'runtime-' + APP_VERSION;

const PRECACHE_URLS = ['./', './index.html', './offline.html']; /* __PRECACHE_URLS__ */

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const cache = await caches.open(CACHE_STATIC);
  // 1本でも失敗すると addAll 全体が落ちるため、個別に入れる
  await Promise.all(PRECACHE_URLS.map((u) =>
    cache.add(new Request(u, { cache: 'reload' }))
      .catch((err) => console.warn('[sw] precache skipped', u, err))));
  // ここでは skipWaiting しない。
  // 服の登録や AI との相談の途中で画面が入れ替わると、打ちかけの入力や
  // 選びかけのコーデが消える。画面側で押してもらってから切り替える。
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys
    .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_STATIC && k !== CACHE_RUNTIME)
    .map((k) => caches.delete(k)));            // ← 自アプリ分だけ削除
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Gemini API は決してキャッシュしない。
  // 古い応答を返すと「昨日と同じ提案しか出ない」ことになるうえ、
  // API キーの付いた URL をキャッシュに残すことになる。
  if (url.origin !== location.origin) return;

  // 画面遷移は network-first。更新をすぐ届け、圏外なら手元の控えを出す
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        return (await caches.match('./index.html'))
          || (await caches.match('./offline.html'))
          || Response.error();
      }
    })());
    return;
  }

  // 静的ファイルは cache-first（回線が細くても即表示）
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    // エラー応答や opaque を溜め込まない
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE_RUNTIME).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match('./offline.html'))));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
