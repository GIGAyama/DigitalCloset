/*
 * Service Worker の登録と、更新の案内。
 *
 * ここを React の useEffect に移してはいけない（§3-6）。
 * effect は描画のあとに走るため、そのとき load はもう終わっている。
 * リスナーは付くが二度と呼ばれず、Service Worker が黙って登録されなくなる。
 * 「登録」と「更新の案内」を一体にしようとして React 側へ移すのは自然に起きるので、
 * 必ず readyState の分岐を残すこと。
 */

// 「さいしんにする」を押したかどうか。これだけが切り替えの合図になる。
let userAskedUpdate = false;
let reloading = false;

// 画面側（React）へ「新しい版があります」を伝えるための入れもの。
// registration を直接渡さず関数で受けるのは、UI の都合を Service Worker 側に
// 持ち込まないため。
let onUpdateReady = null;
let pendingWorker = null;

/** 画面側から更新の案内を受け取る。既に待機中なら即座に呼ぶ。 */
export function onUpdateAvailable(handler) {
  onUpdateReady = handler;
  if (pendingWorker) handler(() => applyUpdate(pendingWorker));
  return () => { onUpdateReady = null; };
}

function applyUpdate(worker) {
  userAskedUpdate = true;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

function notify(worker) {
  pendingWorker = worker;
  if (onUpdateReady) onUpdateReady(() => applyUpdate(worker));
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // 開発中（vite dev）は登録しない。
  // 直したはずの画面が古いキャッシュから出てきて、原因を探して時間を溶かす。
  if (import.meta.env.DEV) return;

  const start = async () => {
    try {
      const registration = await navigator.serviceWorker.register(
        `${import.meta.env.BASE_URL}sw.js`,
        { scope: import.meta.env.BASE_URL },
      );

      registration.addEventListener('updatefound', () => {
        const sw = registration.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // controller が居る＝初回インストールではなく更新。
          // 初回で通知すると「入れた直後に更新があります」と出て混乱する。
          if (sw.state === 'installed' && navigator.serviceWorker.controller) notify(sw);
        });
      });

      // 前回のうちに入っていた場合も拾う
      if (registration.waiting && navigator.serviceWorker.controller) notify(registration.waiting);
    } catch (err) {
      // 登録に失敗してもアプリは動く。オフラインで開けなくなるだけ。
      console.warn('[pwa] Service Worker の登録に失敗しました', err);
    }
  };

  // ⚠️ ここが §3-6 の肝。もう load が済んでいるなら、その場で走らせる。
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });

  // ⚠️ controllerchange は、はじめて開いたときにも飛んでくる。
  //    activate の clients.claim() でページが管理下に入るためである。
  //    これを素直に受けると初回訪問が必ず1回リロードされ、
  //    打ちかけの入力や選びかけのコーデが消える。
  //    「もともと管理下だったか」で分ける直し方は別の形で壊れる
  //    （入れた直後に更新を押すと、切り替わったのに読み込み直されない）。
  //    見るべきは利用者が押したかどうかだけ。
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!userAskedUpdate || reloading) return;
    reloading = true;
    location.reload();
  });
}

/** ホーム画面から起動している（＝もうインストール済み）か。 */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

/** iOS Safari には beforeinstallprompt が無いので、案内の出し分けに使う。 */
export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
