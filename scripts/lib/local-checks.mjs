/**
 * このリポジトリだけの検査。
 *
 * 共通の検査は正本（GIGAyama.github.io/standards/lib/giga-v5-checks.mjs）が
 * 受け持つ。ここに残すのは、正本に対応するものが無いものだけである。
 *
 * 移行のとき（2026-08-22）に、フォーク 40 件を正本 38 件へ1つずつ突き合わせた。
 * 名前が変わっただけのものと、正本では1つにまとまったもの（B1b/B1c → B_CSP、
 * D14 → D_VIEWPORT、P_*_SIZE → F_IMG_SIZE、E2b → E_ICONS、
 * E7b → E_SW_UPDATE_PROMPT）を除くと、行き先が無いのは下の 2 件だけだった。
 * dist を見る 4 件は正本の守備範囲の外なので、あわせてここに置く。
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

/** 読めば分かるもの。正本に行き先が無かった 2 件。 */
export function runLocalChecks(cfg) {
  const out = [];
  const add = (id, ok, message) => out.push({ id, ok, message, severity: 'error' });

  const srcFiles = walk('src');
  const js = stripComments(
    srcFiles.filter((p) => ['.js', '.jsx'].includes(extname(p)))
      .map((p) => readFileSync(p, 'utf8')).join('\n'));
  const css = stripComments(
    srcFiles.filter((p) => extname(p) === '.css')
      .map((p) => readFileSync(p, 'utf8')).join('\n'));

  // 指の当たる面を 44px まで広げる下じき。見た目を変えずに当たり判定だけ
  // 広げたいので、要素そのものではなく疑似要素で用意する決まりにしている。
  add('D9_TAP_HELPER', /\.tap-44::after/.test(css) && /min-width:\s*44px/.test(css),
    'タップ領域を広げる .tap-44 が疑似要素で用意されていること');

  // モーダルは、開いている間ほかを触れなくし、Esc で閉じられること。
  // モーダルを持たないなら対象外。
  add('F2_MODAL_A11Y', (() => {
    if (!/role="dialog"/.test(js)) return !/Modal/.test(js);
    return /aria-modal="true"/.test(js) && /['"]Escape['"]/.test(js);
  })(), 'モーダルに role="dialog" / aria-modal と Esc で閉じる処理が在ること');

  // 正本の E_INSTALL_HOOK は「<head> で合図を受けているか」を見る。
  // 読み込んでいる先のファイルが在るかは見ていないので、ここで見る。
  // 消えていれば本番で 404 になり、インストールの合図を取りこぼす。
  const indexHtml = existsSync('index.html') ? readFileSync('index.html', 'utf8') : '';
  const hook = indexHtml.replace(/<!--[\s\S]*?-->/g, '')
    .match(/<script[^>]*src=["']([^"']*install-hook\.js)["']/);
  add('E3b_INSTALL_HOOK_FILE',
    !hook || existsSync(join('public', hook[1].replace(/^\.?\//, ''))),
    'index.html が読んでいる install-hook.js の実体が在ること');

  return out;
}

/**
 * ビルドした結果を見るもの。正本は原文だけを見るので、ここは守備範囲の外。
 * dist が無ければ何も返さない（ビルド前でもゲートが動くように）。
 */
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

  // 直下に置いた HTML は、vite.config.js の rollupOptions.input に並べたものしか
  // dist/ に出ない。書き落とすと、ファイルはあるのに配信物へ入らず本番で 404 になる。
  // privacy.html と terms.html はアプリ本体からリンクしていないので、画面では気づけない。
  // 実際に 2026-08 の配信で両方が抜け落ちていた。ここで出口の側から数える。
  const rootPages = readdirSync('.').filter((n) => extname(n) === '.html');
  const missing = rootPages.filter((n) => !existsSync(join('dist', n)));
  add('E12_HTML_SHIPPED', missing.length === 0,
    `直下の HTML がすべて dist/ に出ていること（${rootPages.length} 件${missing.length ? `／欠け: ${missing.join(', ')}` : ''}）`);

  const sw = readFileSync('dist/sw.js', 'utf8');
  add('E11_VERSION_FILLED', !/APP_VERSION = 'dev'/.test(sw),
    'dist/sw.js の APP_VERSION がビルド時に埋まっていること');
  add('E11_PRECACHE_FILLED', /PRECACHE_URLS = \["\.\/","\.\/assets\//.test(sw),
    'dist/sw.js の先読み一覧に実際のファイル名が入っていること');

  return out;
}
