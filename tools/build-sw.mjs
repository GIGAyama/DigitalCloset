#!/usr/bin/env node
/**
 * ビルド後に dist/sw.js の APP_VERSION と PRECACHE_URLS を実体で埋める。
 *
 * なぜ手で書かないか
 *   - Vite の出力するファイル名にはハッシュが付く（index-ti_VyL6O.js）。
 *     手で並べた一覧は次のビルドで必ず古くなり、
 *     「圏外で開いたら真っ白」という形で初めて気づくことになる。
 *   - APP_VERSION の更新漏れは「更新が反映されない」の最大の原因（§3-5）。
 *     リリース手順書に書いて人間に覚えさせるより、中身から作るほうが漏れない。
 *
 * APP_VERSION は先読み対象ファイルの中身から作るので、
 * 中身が1バイトでも変われば必ず変わり、変わらなければ変わらない。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const DIST = 'dist';
const SW = join(DIST, 'sw.js');

// 先読みに入れるもの。
// §6：大きな塊を先読みに入れると、初回表示が止まる。
// このアプリの JS は 250KB 程度なので入れてよいが、上限を決めて超えたら知らせる。
const PRECACHE_MAX_BYTES = 1024 * 1024;   // 1MB（§8 総アセット初回 1MB以下）

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const all = walk(DIST);

// 圏外でアプリが起動するのに要るものだけ。
// favicon やスクリーンショットは無くても起動するので runtime キャッシュに任せる。
const wanted = all.filter((p) => {
  const rel = relative(DIST, p).split('\\').join('/');
  if (rel === 'sw.js') return false;                       // 自分自身は入れない
  if (rel === 'index.html' || rel === 'offline.html') return true;
  if (rel === 'manifest.webmanifest' || rel === 'install-hook.js') return true;
  // 利用規約・プライバシーの行き先を出す部品。入れておかないと、圏外で開いた
  // ときだけリンクが 1 本も出ない（行き先は開けなくても、どこにあるかは見える）。
  if (rel === 'giga-app-links.js') return true;
  if (rel.startsWith('assets/')) return true;              // ハッシュ付きの JS / CSS
  if (rel === 'icons/icon-192.png' || rel === 'icons/icon-512.png') return true;
  return false;
});

const urls = ['./', ...wanted.map((p) => './' + relative(DIST, p).split('\\').join('/'))];

const total = wanted.reduce((n, p) => n + statSync(p).size, 0);
if (total > PRECACHE_MAX_BYTES) {
  console.warn(`[build-sw] ⚠️ 先読みが ${(total / 1024).toFixed(0)}KB あります（目安 ${PRECACHE_MAX_BYTES / 1024}KB）。`);
  console.warn('           40人が同時に開く回線では初回表示が止まります。大きい塊を外してください。');
}

// 版は「先読みするものの中身」から作る。ファイル名だけでなく中身も混ぜる。
const h = createHash('sha256');
for (const p of wanted.sort()) {
  h.update(relative(DIST, p));
  h.update(readFileSync(p));
}
const version = 'v' + h.digest('hex').slice(0, 12);

let src = readFileSync(SW, 'utf8');
const before = src;

src = src.replace(
  /^const APP_VERSION = .*; \/\* __APP_VERSION__ \*\/$/m,
  `const APP_VERSION = '${version}'; /* __APP_VERSION__ */`,
);
src = src.replace(
  /^const PRECACHE_URLS = .*; \/\* __PRECACHE_URLS__ \*\/$/m,
  `const PRECACHE_URLS = ${JSON.stringify(urls)}; /* __PRECACHE_URLS__ */`,
);

// 置換できていなければ、黙って「dev」のまま配ることになる。
// それは「更新が反映されない」と「圏外で真っ白」を同時に起こすので、必ず落とす。
if (src === before || src.includes("APP_VERSION = 'dev'")) {
  console.error('[build-sw] ❌ dist/sw.js の目印を書き換えられませんでした。');
  console.error('           public/sw.js の __APP_VERSION__ / __PRECACHE_URLS__ の行を確かめてください。');
  process.exit(1);
}

writeFileSync(SW, src);
console.log(`[build-sw] APP_VERSION = ${version}`);
console.log(`[build-sw] 先読み ${urls.length} 件 / ${(total / 1024).toFixed(1)} KB`);
