#!/usr/bin/env node
/**
 * GIGA Standard v5 §7-5 PWA の挙動を実測する。
 *
 * sw.js を読んでも分からないことばかりなので、実際に動かして数える。
 *   - Service Worker が本当に登録されているか
 *   - 初回訪問で勝手にリロードしないか（画面遷移が1回か）
 *   - 押すまで切り替わらないか（3秒放置して waiting のままか）
 *   - 押したら切り替わるか
 *   - 他アプリのキャッシュを巻き添えにしないか
 *   - 圏外で起動するか／本体が無ければ offline.html が出るか
 *
 * 使い方: node tools/measure-pwa.mjs [--url http://127.0.0.1:4173/]
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize, extname } from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const require = createRequire(import.meta.url);
  const root = require('node:child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
  ({ chromium } = await import(`${root}/playwright/index.mjs`));
}

const SW_FILE = 'dist/sw.js';
// 本番と同じ「ドメイン直下」で配る。独自ドメイン digitalcloset.giga-school.com では
// アプリがドメイン直下に置かれるので、旧構成の '/DigitalCloset/' の下で配ると、
// 本番では 404 になるパスが測定環境でだけ通り、壊れていても「合格」と出る。
const BASE = '/';

// ---------------------------------------------------------------------------
// 配信サーバーは、このスクリプトが自分で起こす。
//
// ⚠️ 外の preview サーバーに向けて context.setOffline(true) しても「圏外」にはならない。
//    setOffline はページ側のネットワークにしか効かず、Service Worker は別の
//    ネットワーク文脈で動くため、そのまま本物のサーバーへ取りに行ってしまう。
//    実際、それに気づかず測っていたときは「圏外で起動した」と出ていたが、
//    中身は単にサーバーから取ってきた本体だった。
//    サーバーそのものを止めるのが、いちばん確かで嘘のない「圏外」である。
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

let server = null;
const sockets = new Set();

function startServer() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (!p.startsWith(BASE)) { res.writeHead(404).end(); return; }
      p = p.slice(BASE.length) || 'index.html';
      const file = join('dist', normalize(p).replace(/^(\.\.[/\\])+/, ''));
      try {
        const target = statSync(file).isDirectory() ? join(file, 'index.html') : file;
        const body = readFileSync(target);
        res.writeHead(200, {
          'Content-Type': MIME[extname(target)] || 'application/octet-stream',
          // 検査のたびにブラウザの控えが効くと、消したはずのものが出てくる
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      }
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}${BASE}`));
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    for (const s of sockets) s.destroy();     // 生きている接続も切る
    server.close(() => { server = null; resolve(); });
  });
}

const URL_ARG = await startServer();
console.log(`検査用サーバー: ${URL_ARG}\n`);
const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name} … ${detail}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();

let navigations = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

// --- 1. まっさらな状態で1回開く ------------------------------------------
await page.goto(URL_ARG, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

ok('初回訪問で勝手にリロードしない', navigations === 1, `画面遷移 ${navigations} 回（1回なら正常）`);

const reg1 = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return r ? { scope: r.scope, state: r.active?.state || null } : null;
});
ok('Service Worker が登録されている', !!reg1 && reg1.state === 'activated',
  reg1 ? `scope=${reg1.scope} state=${reg1.state}` : '登録されていない');

// --- 2. 他アプリのキャッシュを巻き添えにしないか --------------------------
// 同一オリジンに別アプリのキャッシュを2つ置いてから、版を上げる。
await page.evaluate(async () => {
  await caches.open('other-app-static-v1');
  await caches.open('townmap-mikke-static-v3');
});
const cachesBefore = await page.evaluate(() => caches.keys());
ok('検証用に他アプリのキャッシュを設置', cachesBefore.length >= 2, cachesBefore.join(', '));

// --- 3. 版を上げる（sw.js を書き換えて updatefound を起こす）--------------
const original = readFileSync(SW_FILE, 'utf8');
copyFileSync(SW_FILE, `${SW_FILE}.bak`);
writeFileSync(SW_FILE, original.replace(
  /^const APP_VERSION = '([^']*)';/m,
  (_, v) => `const APP_VERSION = '${v}-test';`,
));

await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  await r.update();
});
// 3秒放置する。押していないのに切り替わるなら、ここで controller が変わる。
const controllerBefore = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || null);
await page.waitForTimeout(3000);

const state = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return {
    waiting: !!r.waiting,
    active: r.active?.state || null,
    controller: navigator.serviceWorker.controller?.scriptURL || null,
  };
});
ok('押すまで切り替わらない（3秒放置）', state.waiting === true,
  state.waiting ? '新しい版は waiting のまま' : '待機していない（勝手に切り替わった可能性）');

const navsBeforeApply = navigations;

// --- 4. 画面の案内が出ているか、押したら切り替わるか ----------------------
const notice = page.getByText('あたらしい版があります');
const noticeShown = await notice.count() > 0;
ok('更新の案内が画面に出る', noticeShown, noticeShown ? '「あたらしい版があります」を表示' : '案内が出ていない');

if (noticeShown) {
  await page.getByRole('button', { name: 'さいしんに する' }).click();
  await page.waitForTimeout(3000);
  const after = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    return { waiting: !!r.waiting, keys };
  });
  ok('押したら切り替わる', after.waiting === false && navigations > navsBeforeApply,
    `waiting=${after.waiting} / 押したあとの画面遷移 +${navigations - navsBeforeApply}`);

  const survivors = after.keys.filter((k) => k === 'other-app-static-v1' || k === 'townmap-mikke-static-v3');
  ok('他アプリのキャッシュが残っている', survivors.length === 2,
    `残 ${survivors.length}/2 … いま在るもの: ${after.keys.join(', ')}`);

  const stale = after.keys.filter((k) => k.startsWith('digital-closet-') && !k.includes('-test'));
  ok('自アプリの古いキャッシュは消えている', stale.length === 0,
    stale.length ? `残っている: ${stale.join(', ')}` : '古い版は削除済み');
}

// 書き換えた sw.js を元に戻す
writeFileSync(SW_FILE, original);

// --- 5. 圏外で起動するか --------------------------------------------------
// サーバーを止めてから読み直す。ここで出るものは、手元の控えだけで組み立てた画面である。
const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const p2 = await ctx2.newPage();
await p2.goto(URL_ARG, { waitUntil: 'networkidle' });
await p2.waitForTimeout(2500);          // 先読みが終わるのを待つ

await stopServer();
await p2.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await p2.waitForTimeout(2000);
const offlineWorks = await p2.evaluate(() =>
  !!document.querySelector('#root')?.children.length
  && document.body.innerText.includes('クローゼット'));
ok('圏外で起動する（サーバーを止めて確認）', offlineWorks,
  offlineWorks ? 'アプリ本体が手元の控えから表示された' : '真っ白／本体が出ない');

// --- 6. 本体のキャッシュだけ消すと offline.html が出るか -------------------
// サーバーは止めたまま。本体の控えが無く、外にも出られない状況を作る。
const remaining = await p2.evaluate(async () => {
  for (const key of await caches.keys()) {
    if (!key.startsWith('digital-closet-')) continue;
    const c = await caches.open(key);
    for (const req of await c.keys()) {
      if (!new URL(req.url).pathname.endsWith('offline.html')) await c.delete(req);
    }
  }
  return (await caches.match('./index.html')) ? 'index.html が残っている' : 'index.html は削除済み';
});
await p2.goto(URL_ARG, { waitUntil: 'domcontentloaded' }).catch(() => {});
await p2.waitForTimeout(1500);
const offlinePage = await p2.evaluate(() => document.body.innerText.slice(0, 160));
const shown = offlinePage.includes('インターネット');
ok('offline.html が出る', shown,
  shown ? `「インターネットに つながっていません」（${remaining}）`
        : `出たもの: ${offlinePage.replace(/\n/g, ' ').slice(0, 90)}`);

await browser.close();

if (existsSync(`${SW_FILE}.bak`)) {
  copyFileSync(`${SW_FILE}.bak`, SW_FILE);
  (await import('node:fs')).unlinkSync(`${SW_FILE}.bak`);
}
await stopServer();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 項目が通りました。`);
process.exit(failed.length ? 1 : 0);
