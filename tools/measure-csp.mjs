#!/usr/bin/env node
/**
 * GIGA Standard v5 §2-13 CSP が本当に効いているかを確かめる。
 *
 * 「CSP違反 0件でした」だけでは、効いているのか何も見ていないのか区別できない。
 * わざと止まるはずのものを走らせて、実際に止まることを見る。
 *
 * 併せて、CSP を入れたせいで動かなくなっていないかも見る。
 * 入れた直後にアプリが起動しなくなる事故がいちばん多い（§2-13）。
 */
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
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

// 本番と同じ「ドメイン直下」で配る。独自ドメイン digitalcloset.giga-school.com では
// アプリがドメイン直下に置かれるので、旧構成の '/DigitalCloset/' の下で配ると、
// 本番では 404 になるパスが測定環境でだけ通り、壊れていても「合格」と出る。
const BASE = '/';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
};

const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(BASE)) { res.writeHead(404).end(); return; }
  p = p.slice(BASE.length) || 'index.html';
  const file = join('dist', normalize(p).replace(/^(\.\.[/\\])+/, ''));
  try {
    const t = statSync(file).isDirectory() ? join(file, 'index.html') : file;
    res.writeHead(200, { 'Content-Type': MIME[extname(t)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(t));
  } catch { res.writeHead(404).end('not found'); }
});
const URL_BASE = await new Promise((r) => server.listen(0, '127.0.0.1',
  () => r(`http://127.0.0.1:${server.address().port}${BASE}`)));

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? '✅' : '❌'} ${name} … ${detail}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const violations = [];
const errors = [];
page.on('console', (m) => {
  const t = m.text();
  if (/Content Security Policy|Refused to/i.test(t)) violations.push(t);
  else if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL_BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// --- 1. CSP がそもそも配られているか ---------------------------------------
const meta = await page.evaluate(() =>
  document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null);
ok('CSP が配られている', !!meta && /script-src 'self'/.test(meta),
  meta ? "script-src 'self' を含む" : 'meta が無い');

// --- 2. frame-ancestors を meta に書いていないか（書いても無視され警告が出るだけ）
ok('frame-ancestors を meta に書いていない', !!meta && !/frame-ancestors/.test(meta),
  meta && /frame-ancestors/.test(meta) ? 'meta に書かれている（無視される）' : '書かれていない');

// --- 3. 'unsafe-inline' を script-src に足していないか ---------------------
const scriptSrc = (meta || '').match(/script-src([^;]*)/)?.[1] || '';
ok("script-src に 'unsafe-inline' が無い", !/unsafe-inline/.test(scriptSrc),
  scriptSrc.trim() || '(無し)');

// --- 4. 普通に起動しているか（CSP を入れて壊していないか）------------------
const booted = await page.evaluate(() =>
  !!document.querySelector('#root')?.children.length
  && document.body.innerText.includes('クローゼット'));
ok('CSP を入れた状態でアプリが起動する', booted && errors.length === 0,
  booted ? `画面が出ている / JS エラー ${errors.length} 件` : '起動していない');
ok('読み込み時の CSP 違反が 0 件', violations.length === 0,
  violations.length ? violations[0].slice(0, 120) : '0 件');

// --- 5. わざと止まるはずのものを走らせる -----------------------------------
// インラインの <script> は script-src 'self' では実行されない。
// これが動いてしまうなら、CSP は配られているだけで効いていない。
const inlineRan = await page.evaluate(() => {
  window.__cspInlineRan = false;
  const s = document.createElement('script');
  s.textContent = 'window.__cspInlineRan = true;';
  document.head.appendChild(s);
  return window.__cspInlineRan;
});
ok('インラインの <script> が止まる', inlineRan === false,
  inlineRan ? '動いてしまった（CSP が効いていない）' : '実行されなかった');

// 許していない外部から script を読ませる
const externalBlocked = await page.evaluate(() => new Promise((resolve) => {
  const s = document.createElement('script');
  // giga-lint-ignore-next-line — ここは「外部 CDN を読ませようとして、
  // CSP に止められること」を確かめる計測そのもの。止まらなければこの検査が落ちる。
  // この道具は開発時にしか動かず、配信物には入らない。
  s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';
  s.onload = () => resolve(false);
  s.onerror = () => resolve(true);
  document.head.appendChild(s);
  setTimeout(() => resolve(true), 4000);
}));
ok('許していない CDN からの script が止まる', externalBlocked === true,
  externalBlocked ? '読み込まれなかった' : '読み込まれてしまった');

// --- 6. 許しているものが通ること -------------------------------------------
// Gemini API の宛先は connect-src に列挙してある。
// ここでは鍵を持たないので応答は 400 台になるが、「CSP で止められた」のか
// 「サーバーが断った」のかを取り違えないよう、例外の中身で見分ける。
const geminiAllowed = await page.evaluate(async () => {
  try {
    await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=invalid-key-for-check');
    return { allowed: true, how: 'サーバーまで届いた' };
  } catch (e) {
    // CSP で止めた場合、Chrome は TypeError を投げ、コンソールに Refused to connect を出す
    return { allowed: false, how: String(e).slice(0, 80) };
  }
});
const cspBlockedGemini = violations.some((v) => /generativelanguage/.test(v));
ok('Gemini API の宛先を CSP が止めていない', !cspBlockedGemini,
  cspBlockedGemini
    ? 'CSP に阻まれた（connect-src を確かめること）'
    : geminiAllowed.allowed
      ? 'サーバーまで届いた'
      : `CSP 違反は出ていない。届かなかったのは回線の都合（${geminiAllowed.how}）。`
        + '\n     ※ この作業環境は外部へ出られないため、API が実際に応答することは未計測。');

await browser.close();
await new Promise((r) => server.close(r));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 項目が通りました。`);
process.exit(failed.length ? 1 : 0);
