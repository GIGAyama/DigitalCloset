/**
 * GIGA Standard v5 Part I の静的検査。
 *
 * ここは「読めば分かること」だけを見る。
 * コントラスト・タップ領域・PWA の挙動・CSP が効いているかは
 * 読んでも分からないので tools/measure*.mjs で実ブラウザから測る。
 * 静的検査が通ったことを「測った」と言わないこと。
 *
 * ⚠️ 検査そのものが壊れていないかは scripts/verify-gate.mjs が確かめる。
 *    「0件でした」だけでは、効いているのか何も見ていないのか区別できない。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

/** 判定の前にコメントを落とす。
 *  「localStorage は操作しない」という注意書きに検査が反応する誤検知を防ぐ。 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // ブロックコメント
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')      // 行コメント（URL の // は残す）
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');     // JSX のコメント
}

/**
 * HTML のコメントを落とす。
 *
 * これが要る理由は実際に踏んだから書いている。
 * index.html に「user-scalable=no と maximum-scale は書かない」という注意書きを
 * 残したところ、拡大禁止の検査がその注意書きに反応して落ちた。
 * 正しく書いてある上に、なぜそう書いたかを残したことで検査が落ちるのでは、
 * 注意書きを消すほうへ力が働いてしまう。
 */
export function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, ' ');
}

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const size = (p) => (existsSync(p) ? statSync(p).size : null);

/**
 * @returns {{id:string, ok:boolean, message:string, severity:'error'|'warn'}[]}
 */
export function runGigaChecks(cfg) {
  const out = [];
  const add = (id, ok, message, severity = 'error') => out.push({ id, ok, message, severity });

  const htmlRaw = read('index.html') || '';
  const html = stripHtmlComments(htmlRaw);
  const css = walk('src').filter((p) => extname(p) === '.css').map((p) => readFileSync(p, 'utf8')).join('\n');
  const jsFiles = walk('src').filter((p) => ['.js', '.jsx'].includes(extname(p)));
  const js = jsFiles.map((p) => readFileSync(p, 'utf8')).join('\n');
  const jsNoComments = stripComments(js);
  const cssNoComments = stripComments(css);

  // ---- A. 法務・配布 ------------------------------------------------------
  add('A1_LICENSE', existsSync('LICENSE'), 'LICENSE が実ファイルとして在ること');
  add('A2_GITIGNORE', (() => {
    const g = read('.gitignore') || '';
    return ['node_modules', 'dist', '.env'].every((k) => g.includes(k));
  })(), '.gitignore に node_modules / dist / .env が並んでいること');
  add('A3_DEPENDABOT', existsSync('.github/dependabot.yml'), '.github/dependabot.yml が在ること');
  add('A4_DOCS', ['README.md', 'MANUAL.md', 'AUDIT.md'].every(existsSync),
    'README.md / MANUAL.md / AUDIT.md が揃っていること');
  add('A5_CI_ON_PR', (() => {
    const ci = read('.github/workflows/ci.yml');
    if (!ci) return false;
    // ⚠️ 素朴に /pull_request/ を探すと、
    //    「# CI は pull_request でも動かす」という注意書きに当たって通ってしまう。
    //    実際、わざと引き金を外したのに検査が通り抜けた。
    //    コメントを落としたうえで、on: の下の引き金として書かれているかを見る。
    const noComments = ci.replace(/^\s*#.*$/gm, '').replace(/\s#.*$/gm, '');
    const onBlock = noComments.match(/^on:\s*$([\s\S]*?)^\S/m)?.[1]
      ?? noComments.match(/^on:\s*$([\s\S]*)/m)?.[1]
      ?? '';
    return /^\s{2,}pull_request:/m.test(onBlock);
  })(), 'CI が pull_request でも動くこと（push だけだと PR 時点で気づけない）');

  // ---- B. セキュリティ ----------------------------------------------------
  const csp = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([\s\S]*?)"/)?.[1] || '';
  add('B1_CSP', csp.includes("default-src 'self'"), 'CSP が入っていること（効いているかは実測で確かめる）');
  add('B1b_CSP_NO_UNSAFE_INLINE_SCRIPT',
    !/script-src[^;]*unsafe-inline/.test(csp),
    "script-src に 'unsafe-inline' を足していないこと（足すと CSP の意味がほぼ無くなる）");
  add('B1c_CSP_NO_FRAME_ANCESTORS',
    !/frame-ancestors/.test(csp),
    'frame-ancestors を <meta> に書いていないこと（無視され警告が出るだけ）');
  add('B2_NO_SECRETS', (() => {
    // 直書きされた API キーらしきもの。利用者が入力して localStorage に置く作りは対象外。
    const suspicious = /(AIza[0-9A-Za-z_-]{35})|(sk-[A-Za-z0-9]{32,})/;
    return !suspicious.test(js) && !suspicious.test(html);
  })(), 'API キーやトークンが直書きされていないこと');
  add('B6_NO_CDN_RUNTIME', (() => {
    const bad = /babel\/standalone|cdn\.tailwindcss\.com|unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/;
    return !bad.test(html);
  })(), 'CDN から取る実行コードが 0 バイトであること');
  add('B4_POSTMESSAGE', !/postMessage\([^)]*,\s*['"`]\*['"`]\)/.test(jsNoComments),
    "postMessage の宛先が '*' でないこと");

  // ---- C. 堅牢性 ----------------------------------------------------------
  add('C3_PAGEHIDE', /addEventListener\(\s*['"]pagehide['"]/.test(jsNoComments),
    'pagehide で記録を確定していること（Chromebook はタブを黙って破棄する）');
  add('C5_NO_LS_CLEAR', !/localStorage\.clear\s*\(/.test(jsNoComments),
    'localStorage.clear() を使っていないこと（アプリ間で共有する領域を巻き添えにする）');

  // ---- D. 表示 ------------------------------------------------------------
  add('D1_VIEWPORT_FIT', /name="viewport"[^>]*viewport-fit=cover/.test(html),
    'viewport に viewport-fit=cover が在ること');
  add('D14_NO_ZOOM_BLOCK', !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(html),
    '拡大を禁止していないこと（user-scalable=no / maximum-scale）');
  add('D2_DVH', (() => {
    // ⚠️ @supports not (height: 100dvh) { … 100vh } は正しい書き方なので誤検知しない。
    //    「100vh を含む行」ではなく「dvh の備えがあるか」を見る。前方も見る。
    const all = cssNoComments + '\n' + jsNoComments;
    const usesVh = /\b100vh\b/.test(all);
    if (!usesVh) return /\b100dvh\b/.test(all);
    // 100vh を使っているなら、@supports の中だけであること
    const supportsBlocks = [...cssNoComments.matchAll(/@supports\s+not\s*\(height:\s*100dvh\)\s*\{([\s\S]*?)\}\s*\}?/g)]
      .map((m) => m[1]).join('\n');
    const outside = all.split(/\b100vh\b/).length - 1;
    const inside = supportsBlocks.split(/\b100vh\b/).length - 1;
    return /\b100dvh\b/.test(all) && outside === inside;
  })(), '100dvh を使い、100vh は @supports のフォールバックだけであること');
  add('D3_SAFE_AREA', /safe-area-inset/.test(cssNoComments),
    'safe-area-inset を適用していること');
  add('D4_FLUID_TYPE', /clamp\(/.test(cssNoComments),
    'clamp() による fluid type が在ること');
  add('D5_CANVAS_DPR', (() => {
    // 画面に描く Canvas があるなら DPR 補正が要る。
    // 書き出し用（toDataURL で画像を作るだけ）は §2-5 の通り固定値でよい。
    const drawsToScreen = /<canvas/i.test(js) || /canvasRef/.test(jsNoComments);
    if (!drawsToScreen) return true;
    return /devicePixelRatio/.test(jsNoComments);
  })(), '画面に描く Canvas に devicePixelRatio 補正（上限2）が在ること');
  add('D7_IMG_DIMENSIONS', (() => {
    // <img> には width/height を書く（CLS 対策）。
    const imgs = [...jsNoComments.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    const missing = imgs.filter((t) => !/\bwidth[=\s]/.test(t) || !/\bheight[=\s]/.test(t));
    return { pass: missing.length === 0, n: missing.length };
  })().pass, '<img> に width/height が書かれていること（レイアウトのガタつき対策）');
  add('D10_REDUCED_MOTION', (() => {
    const m = cssNoComments.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    if (!m) return false;
    // ⚠️ .01ms であって 0 ではない。0 にすると fill-mode: forwards が壊れ、
    //    fadeIn 系の要素が opacity: 0 のまま消える。
    return /animation-duration:\s*\.?0*1ms/.test(m[1]) && !/animation-duration:\s*0s?\s*!/.test(m[1]);
  })(), 'prefers-reduced-motion 対応が在り、.01ms であって 0 でないこと');
  add('D11_FORCED_COLORS', /@media\s*\(forced-colors:\s*active\)/.test(cssNoComments),
    'forced-colors 対応が在ること');
  add('D9_TAP_HELPER', /\.tap-44::after/.test(cssNoComments) && /min-width:\s*44px/.test(cssNoComments),
    'タップ領域を広げる .tap-44 が疑似要素で用意されていること');

  // ---- E. PWA -------------------------------------------------------------
  const manifestRaw = read('public/manifest.webmanifest');
  let manifest = null;
  try { manifest = manifestRaw ? JSON.parse(manifestRaw) : null; } catch { /* 壊れていれば下で落ちる */ }
  const repo = cfg.repoName;

  add('E1_MANIFEST_PATHS', (() => {
    if (!manifest) return false;
    const want = `/${repo}/`;
    return manifest.id === want && manifest.scope === want && manifest.start_url === want;
  })(), `manifest の id / scope / start_url が /${repo}/ の絶対パスであること`);

  add('E2_ICONS', ['icon-192', 'icon-512', 'maskable-192', 'maskable-512', 'apple-touch-icon']
    .every((n) => existsSync(`public/icons/${n}.png`)),
    'アイコン4種と apple-touch-icon が在ること');
  add('E2b_APPLE_ICON_DEDICATED', (() => {
    const m = html.match(/rel="apple-touch-icon"[^>]*href="([^"]+)"/);
    if (!m) return false;
    // 角丸の外が透明な icon-192.png を流用していないこと（iOS が黒で埋める）
    return /apple-touch-icon\.png/.test(m[1]);
  })(), 'apple-touch-icon が専用画像を指していること（透明を含む icon を流用しない）');

  add('E3_INSTALL_HOOK', (() => {
    if (!existsSync('public/install-hook.js')) return false;
    const idx = html.indexOf('install-hook.js');
    if (idx < 0) return false;
    // 合図はバンドルより先に受け取る必要がある
    const bundle = html.indexOf('src/main.jsx');
    return bundle < 0 || idx < bundle;
  })(), 'beforeinstallprompt を head 上部の外部ファイルで捕捉していること');

  const sw = read('public/sw.js');
  const swNoComments = sw ? stripComments(sw) : '';
  add('E5_SW_CACHE_SCOPED', (() => {
    if (!sw) return false;
    // ⚠️ 「消す式」を正規表現で追うと (k) => caches.delete(k) を見落とす。
    //    見るべきは「startsWith で自アプリ分に絞る式が在るか」。
    if (!/caches\.keys\s*\(/.test(swNoComments)) return true;   // そもそも消していない
    return /startsWith\s*\(\s*CACHE_PREFIX/.test(swNoComments)
      || /startsWith\s*\(\s*['"`][\w-]+-['"`]/.test(swNoComments);
  })(), 'sw.js が自アプリ接頭辞のキャッシュだけを消していること');
  add('E6_SW_NO_LOCALSTORAGE', !/localStorage/.test(swNoComments),
    'sw.js が localStorage に触れていないこと（判定前にコメントは落としてある）');
  add('E7_SW_NO_SKIPWAITING_IN_INSTALL', (() => {
    if (!sw) return false;
    const install = swNoComments.match(/addEventListener\(\s*['"]install['"][\s\S]*?\n\}\)\)\);/)?.[0]
      || swNoComments.split(/addEventListener\(\s*['"]activate['"]/)[0];
    return !/skipWaiting\s*\(/.test(install);
  })(), 'install の中で skipWaiting() していないこと（操作中に画面が入れ替わる）');
  add('E9_SW_REGISTER_READYSTATE', (() => {
    const pwa = read('src/pwa.js') || js;
    const s = stripComments(pwa);
    // load を待つだけだと、すでに load 済みのときリスナーが二度と呼ばれない
    if (!/addEventListener\(\s*['"]load['"]/.test(s)) return /serviceWorker\.register/.test(s);
    return /readyState\s*===?\s*['"]complete['"]/.test(s);
  })(), 'Service Worker の登録に readyState の分岐が在ること');
  add('E7b_CONTROLLERCHANGE_GUARDED', (() => {
    const pwa = stripComments(read('src/pwa.js') || js);
    if (!/controllerchange/.test(pwa)) return true;
    // 素直に受けると初回訪問が必ず1回リロードされる
    return /userAskedUpdate|userRequested|askedUpdate/.test(pwa);
  })(), 'controllerchange を利用者が押したときだけ受けていること');
  add('E10_OFFLINE_HTML', (() => {
    const o = read('public/offline.html');
    if (!o) return false;
    // 外部資産にも JavaScript にも頼らない
    return !/<script/i.test(o) && !/https?:\/\//.test(o.replace(/xmlns="[^"]*"/g, ''));
  })(), 'offline.html が在り、外部資産にも JavaScript にも頼っていないこと');
  add('E11_APP_VERSION_GENERATED', (() => {
    if (!sw) return false;
    // 版はビルド時に中身から作る。手で書くと必ず更新漏れが起きる。
    return /__APP_VERSION__/.test(sw) && existsSync('tools/build-sw.mjs');
  })(), 'APP_VERSION がビルド時に実バイトから作られること');

  // ---- F. アクセシビリティ・性能 -------------------------------------------
  add('F2_MODAL_A11Y', (() => {
    if (!/role="dialog"/.test(jsNoComments)) return !/Modal/.test(jsNoComments);
    return /aria-modal="true"/.test(jsNoComments) && /['"]Escape['"]/.test(jsNoComments);
  })(), 'モーダルに role="dialog" / aria-modal と Esc で閉じる処理が在ること');
  add('F4_RT_COLOR', (() => {
    // ふりがなを使っていないなら対象外。使うなら色を決め打ちしない。
    if (!/<ruby/.test(jsNoComments) && !/\brt\s*\{/.test(cssNoComments)) return true;
    return /rt\s*\{[^}]*color:\s*inherit/.test(cssNoComments);
  })(), 'rt（ふりがな）の色を決め打ちしていないこと');
  add('F6_FILE_SIZE', (() => {
    const big = walk('src').filter((p) => {
      const s = readFileSync(p, 'utf8');
      return s.split('\n').length > cfg.limits.maxFileLines || Buffer.byteLength(s) > cfg.limits.maxFileBytes;
    });
    return { pass: big.length === 0, big };
  })().pass, `1ファイルが ${cfg.limits.maxFileLines}行 / ${cfg.limits.maxFileBytes / 1024}KB を超えないこと`);

  // ---- 画像・性能 ---------------------------------------------------------
  add('P_FAVICON_SIZE', (() => {
    const s = size('public/favicon.png');
    return s === null || s <= cfg.limits.maxFaviconBytes;
  })(), `favicon.png が ${cfg.limits.maxFaviconBytes / 1024}KB 以下であること`);
  add('P_ICON512_SIZE', (() => {
    const s = size('public/icons/icon-512.png');
    return s === null || s <= cfg.limits.maxPwaIcon512Bytes;
  })(), `icon-512.png が ${cfg.limits.maxPwaIcon512Bytes / 1024}KB 以下であること`);
  add('P_PHOTO_SIZE', (() => {
    const over = walk('public')
      .filter((p) => ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(p)))
      .filter((p) => !p.includes('icons') && !p.endsWith('favicon.png'))
      .filter((p) => statSync(p).size > cfg.limits.maxPhotoBytes);
    return over.length === 0;
  })(), `写真・イラストが ${cfg.limits.maxPhotoBytes / 1024}KB 以下であること`);

  return out;
}

/** ビルド成果物に対する検査（dist が在るときだけ動く）。 */
export function runBuildChecks(cfg) {
  const out = [];
  const add = (id, ok, message) => out.push({ id, ok, message, severity: 'error' });
  if (!existsSync('dist')) return out;

  const assets = walk('dist/assets');
  const jsBytes = assets.filter((p) => extname(p) === '.js').reduce((n, p) => n + statSync(p).size, 0);
  add('F5_INITIAL_JS', jsBytes <= cfg.limits.maxInitialJsBytes,
    `初回 JS が ${(cfg.limits.maxInitialJsBytes / 1024).toFixed(0)}KB 以下であること（実測 ${(jsBytes / 1024).toFixed(1)}KB）`);

  const total = walk('dist').reduce((n, p) => n + statSync(p).size, 0);
  add('P_TOTAL_ASSETS', total <= cfg.limits.maxTotalAssetBytes,
    `総アセットが ${(cfg.limits.maxTotalAssetBytes / 1024).toFixed(0)}KB 以下であること（実測 ${(total / 1024).toFixed(1)}KB）`);

  const sw = readFileSync('dist/sw.js', 'utf8');
  add('E11_VERSION_FILLED', !/APP_VERSION = 'dev'/.test(sw),
    'dist/sw.js の APP_VERSION がビルド時に埋まっていること');
  add('E11_PRECACHE_FILLED', /PRECACHE_URLS = \["\.\/","\.\/assets\//.test(sw),
    'dist/sw.js の先読み一覧に実際のファイル名が入っていること');

  return out;
}
