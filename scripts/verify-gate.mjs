#!/usr/bin/env node
/**
 * 品質ゲートそのものを検査する（GIGA Standard v5 §P4）。
 *
 * 「0件でした」だけでは、検査が動いているのか何も見ていないのか区別できない。
 * わざと壊した複製を作り、狙った検査が「ちゃんと落ちる」ことを確かめる。
 *
 * この確認をしたおかげで、実際に検査側の不具合が見つかっている:
 *   - D14（拡大禁止）が index.html の「user-scalable=no と書かない」という
 *     注意書きに反応して落ちていた。判定前に HTML コメントを落として直した。
 *   - E5（キャッシュ全削除）を「消す式」の正規表現で追うと
 *     (k) => caches.delete(k) を見落とす。「startsWith で絞る式が在るか」を見る形に直した。
 *
 *   npm run verify-gate
 */
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const TMP = mkdtempSync(join(tmpdir(), 'giga-gate-'));

// 検査に要るものだけ複製する。node_modules と .git は要らない。
for (const p of ['index.html', 'src', 'public', 'scripts', 'tools', 'LICENSE',
  '.gitignore', '.github', 'quality.config.json', 'README.md', 'MANUAL.md', 'AUDIT.md']) {
  if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(TMP, p), { recursive: true });
}

const { runGigaChecks } = await import(`file://${join(TMP, 'scripts/lib/giga-v5-checks.mjs')}`);
const cfg = JSON.parse(readFileSync(join(ROOT, 'quality.config.json'), 'utf8'));

/**
 * 壊し方の一覧。
 * expect には「その壊し方で落ちてほしい検査の id」を書く。
 */
const CASES = [
  { id: 'A1_LICENSE', file: 'LICENSE', how: 'LICENSE を消す', mutate: null },
  { id: 'A3_DEPENDABOT', file: '.github/dependabot.yml', how: 'dependabot.yml を消す', mutate: null },
  { id: 'A5_CI_ON_PR', file: '.github/workflows/ci.yml', how: 'CI から pull_request を外す',
    mutate: (s) => s.replace(/^\s*pull_request:\s*$/m, '') },
  { id: 'A4_DOCS', file: 'MANUAL.md', how: 'MANUAL.md を消す', mutate: null },

  { id: 'B1_CSP', file: 'index.html', how: 'CSP の meta を丸ごと外す',
    mutate: (s) => s.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '') },
  { id: 'B1b_CSP_NO_UNSAFE_INLINE_SCRIPT', file: 'index.html', how: "script-src に 'unsafe-inline' を足す",
    mutate: (s) => s.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") },
  { id: 'B1c_CSP_NO_FRAME_ANCESTORS', file: 'index.html', how: 'frame-ancestors を meta に書く',
    mutate: (s) => s.replace("script-src 'self';", "frame-ancestors 'none';\n    script-src 'self';") },
  { id: 'B2_NO_SECRETS', file: 'src/App.jsx', how: 'API キーらしき文字列を直書きする',
    mutate: (s) => s.replace('const DEFAULT_GEMINI_MODEL', "const LEAKED = 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r';\nconst DEFAULT_GEMINI_MODEL") },
  { id: 'B6_NO_CDN_RUNTIME', file: 'index.html', how: 'ブラウザ内 Babel を CDN から読ませる',
    mutate: (s) => s.replace('</head>', '  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>\n</head>') },
  { id: 'B4_POSTMESSAGE', file: 'src/App.jsx', how: "postMessage の宛先を '*' にする",
    mutate: (s) => s.replace('export default function App', "function leak(w){ w.postMessage({a:1}, '*'); }\nexport default function App") },

  { id: 'C3_PAGEHIDE', file: 'src/App.jsx', how: 'pagehide の登録を外す',
    mutate: (s) => s.replace("window.addEventListener('pagehide', flush);", '') },
  { id: 'C5_NO_LS_CLEAR', file: 'src/App.jsx', how: 'localStorage.clear() を使う',
    mutate: (s) => s.replace('const showToast =', 'const wipe = () => { localStorage.clear(); };\n  const showToast =') },

  { id: 'D1_VIEWPORT_FIT', file: 'index.html', how: 'viewport から viewport-fit=cover を外す',
    mutate: (s) => s.replace(', viewport-fit=cover', '') },
  { id: 'D14_NO_ZOOM_BLOCK', file: 'index.html', how: '拡大を禁止する（注意書きではなく実際の指定として）',
    mutate: (s) => s.replace('content="width=device-width, initial-scale=1.0, viewport-fit=cover"',
      'content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover"') },
  { id: 'D2_DVH', file: 'src/index.css', how: '@supports の外で 100vh を使う',
    mutate: (s) => s.replace('.app-shell {\n  height: 100dvh;', '.app-shell {\n  height: 100vh;\n  height: 100dvh;') },
  { id: 'D3_SAFE_AREA', file: 'src/index.css', how: 'safe-area-inset をすべて外す',
    mutate: (s) => s.replace(/env\(safe-area-inset-[a-z]+, 0px\)/g, '0px') },
  { id: 'D4_FLUID_TYPE', file: 'src/index.css', how: 'clamp() をやめて固定 px にする',
    mutate: (s) => s.replace(/clamp\([^)]*\)/g, '16px') },
  { id: 'D7_IMG_DIMENSIONS', file: 'src/App.jsx', how: '<img> から width/height を外す',
    mutate: (s) => s.replace('width={64} height={64} decoding="async" className="h-16 w-16', 'className="h-16 w-16') },
  { id: 'D10_REDUCED_MOTION', file: 'src/index.css', how: 'reduced-motion を .01ms ではなく 0 にする',
    mutate: (s) => s.replace('animation-duration: .01ms !important;', 'animation-duration: 0s !important;') },
  { id: 'D11_FORCED_COLORS', file: 'src/index.css', how: 'forced-colors 対応を消す',
    mutate: (s) => s.replace('@media (forced-colors: active)', '@media (min-width: 99999px)') },
  { id: 'D9_TAP_HELPER', file: 'src/index.css', how: '.tap-44 の当たり判定を消す',
    mutate: (s) => s.replace('min-width: 44px; min-height: 44px;', 'min-width: 20px; min-height: 20px;') },

  { id: 'E1_MANIFEST_PATHS', file: 'public/manifest.webmanifest', how: 'id/scope/start_url を "./" に戻す',
    mutate: (s) => s.replace(/"\/DigitalCloset\/"/g, '"./"') },
  { id: 'E2b_APPLE_ICON_DEDICATED', file: 'index.html', how: '透明を含む icon-192 を apple-touch-icon に流用する',
    mutate: (s) => s.replace('icons/apple-touch-icon.png', 'icons/icon-192.png') },
  { id: 'E3_INSTALL_HOOK', file: 'public/install-hook.js', how: 'install-hook.js を消す', mutate: null },
  { id: 'E5_SW_CACHE_SCOPED', file: 'public/sw.js',
    how: 'caches.keys() を全部消す形にする（アロー関数で書いて正規表現から隠す）',
    mutate: (s) => s.replace(
      /const keys = await caches\.keys\(\);[\s\S]*?\.map\(\(k\) => caches\.delete\(k\)\)\);/,
      'const keys = await caches.keys();\n  await Promise.all(keys.map((k) => caches.delete(k)));') },
  { id: 'E6_SW_NO_LOCALSTORAGE', file: 'public/sw.js', how: 'sw.js から localStorage を触る',
    mutate: (s) => s.replace("if (e.data && e.data.type === 'SKIP_WAITING')",
      "self.localStorage;\n  if (e.data && e.data.type === 'SKIP_WAITING')") },
  { id: 'E7_SW_NO_SKIPWAITING_IN_INSTALL', file: 'public/sw.js', how: 'install の中で skipWaiting() する',
    mutate: (s) => s.replace('  // ここでは skipWaiting しない。', '  self.skipWaiting();\n  // ここでは skipWaiting しない。') },
  { id: 'E9_SW_REGISTER_READYSTATE', file: 'src/pwa.js', how: 'readyState の分岐を外して load だけ待つ',
    mutate: (s) => s.replace(/if \(document\.readyState === 'complete'\) start\(\);\s*\n\s*else /, '') },
  { id: 'E7b_CONTROLLERCHANGE_GUARDED', file: 'src/pwa.js', how: 'controllerchange を素直に受ける',
    mutate: (s) => s.replace('if (!userAskedUpdate || reloading) return;', 'if (reloading) return;')
      .replace(/let userAskedUpdate = false;/, 'let unusedFlag = false;')
      .replace(/userAskedUpdate = true;/, 'unusedFlag = true;') },
  { id: 'E10_OFFLINE_HTML', file: 'public/offline.html', how: 'offline.html に JavaScript を足す',
    mutate: (s) => s.replace('</body>', '<script>console.log(1)</script>\n</body>') },
  { id: 'E11_APP_VERSION_GENERATED', file: 'public/sw.js', how: 'APP_VERSION を手書きに戻す',
    mutate: (s) => s.replace("const APP_VERSION = 'dev'; /* __APP_VERSION__ */", "const APP_VERSION = 'v1';") },

  { id: 'F2_MODAL_A11Y', file: 'src/App.jsx', how: 'モーダルから Esc の処理を外す',
    mutate: (s) => s.replace("if (e.key === 'Escape')", 'if (false)') },
  { id: 'F4_RT_COLOR', file: 'src/index.css', how: 'rt の色を決め打ちする',
    mutate: (s) => s + '\nrt { color: #666; }\n' },
  { id: 'P_FAVICON_SIZE', file: 'public/favicon.png', how: 'favicon を 30KB 超にする',
    mutate: () => Buffer.alloc(40 * 1024, 1), binary: true },
];

const originals = new Map();
const readTmp = (f) => readFileSync(join(TMP, f));
const restore = (f) => { if (originals.has(f)) writeFileSync(join(TMP, f), originals.get(f)); };

let pass = 0;
const problems = [];

console.log(`検査そのものを ${CASES.length} 通りの壊し方で確かめます。\n`);

for (const c of CASES) {
  const target = join(TMP, c.file);
  if (!originals.has(c.file) && existsSync(target)) originals.set(c.file, readTmp(c.file));

  // 壊す
  if (c.mutate === null) {
    rmSync(target, { recursive: true, force: true });
  } else if (c.binary) {
    writeFileSync(target, c.mutate());
  } else {
    const before = readFileSync(target, 'utf8');
    const after = c.mutate(before);
    if (after === before) {
      problems.push(`⚠️  ${c.id.padEnd(32)} 壊し方が当たっていない（元の文字列が見つからない）: ${c.how}`);
      restore(c.file);
      continue;
    }
    writeFileSync(target, after);
  }

  // 壊した状態で検査を走らせる
  process.chdir(TMP);
  const results = runGigaChecks(cfg);
  process.chdir(ROOT);

  const hit = results.find((r) => r.id === c.id);
  if (!hit) {
    problems.push(`❌ ${c.id.padEnd(32)} そんな id の検査が無い`);
  } else if (hit.ok) {
    problems.push(`❌ ${c.id.padEnd(32)} 壊したのに通ってしまう … ${c.how}`);
  } else {
    pass++;
    console.log(`  ✅ ${c.id.padEnd(32)} ${c.how} → ちゃんと落ちた`);
  }

  // 直す
  if (c.mutate === null || c.binary) {
    if (originals.has(c.file)) writeFileSync(target, originals.get(c.file));
  } else {
    restore(c.file);
  }
}

// 壊していない状態では全部通ること（直し忘れの検出も兼ねる）
process.chdir(TMP);
const clean = runGigaChecks(cfg).filter((r) => !r.ok);
process.chdir(ROOT);
if (clean.length) {
  problems.push(`❌ 壊していない状態で落ちている: ${clean.map((r) => r.id).join(', ')}`);
} else {
  console.log('\n  ✅ 壊していない状態では全項目が通る');
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass}/${CASES.length} の壊し方で、狙った検査が落ちました。`);
if (problems.length) {
  console.log('\n' + problems.join('\n'));
  console.log('\n❌ 検査そのものに穴があります。');
  process.exit(1);
}
console.log('✅ 品質ゲートは実際に働いています。');
