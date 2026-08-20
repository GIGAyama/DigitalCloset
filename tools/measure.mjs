#!/usr/bin/env node
/**
 * GIGA Standard v5 §7 実測ツール
 *
 * 「読むだけでは分からない」ものを実ブラウザで測る。
 *   - コントラスト比（§2-8）
 *   - タップ領域 44px（§2-9。疑似要素の当たり判定込み）
 *   - 320px 幅での横スクロール（§2-1）
 *   - JS エラー / CSP 違反 / 読み込み失敗（§2-13）
 *   - Service Worker の登録・初回リロード（§3-6, §7-5）
 *
 * 使い方: node tools/measure.mjs [--url http://localhost:4173/DigitalCloset/]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// playwright は「測るため」だけに要るもので、アプリの実行にも CI の品質ゲートにも要らない。
// package.json の依存に入れるとブラウザの取得で CI が数分伸びるので、
// 入っている場所を探して使う形にしてある（グローバル導入でもよい）。
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    const require = createRequire(import.meta.url);
    const paths = require('node:child_process')
      .execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = await import(`${paths}/playwright/index.mjs`));
  } catch {
    console.error('playwright が見つかりません。次のどちらかを実行してください:');
    console.error('  npm i -D playwright   (このリポジトリだけに入れる)');
    console.error('  npm i -g playwright   (端末全体に入れる)');
    process.exit(1);
  }
}

const URL_ARG = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4173/';

// ---------------------------------------------------------------------------
// ページの中で走らせる走査コード。
// §7-2 の通り、色は文字列を数値で拾わずに 1px 実際に塗って読み返す。
// Tailwind v4 の oklch() でも、将来 color(display-p3 …) が来ても壊れない。
// ---------------------------------------------------------------------------
const SCAN = /* js */ `(() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const parse = (s) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const a = d[3] / 255;
    return a === 0 ? [0, 0, 0, 0] : [d[0] / a, d[1] / a, d[2] / a, a];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => {
    const a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  // 実効背景色。透明を遡り、グラデーションの場合は代表色を拾う。
  // §7-2：backgroundColor だけ見ると「白の上の白（比1.0）」という誤報になる。
  const effectiveBg = (el) => {
    let node = el;
    let acc = null;
    while (node && node !== document.documentElement.parentNode) {
      const cs = getComputedStyle(node);
      let c = parse(cs.backgroundColor);
      if (c[3] === 0 && cs.backgroundImage && cs.backgroundImage !== 'none') {
        // グラデーションから色を1つ取り出す。無ければ諦めて上へ。
        const m = cs.backgroundImage.match(/(rgba?\\([^)]*\\)|#[0-9a-f]{3,8}|oklch\\([^)]*\\)|hsla?\\([^)]*\\))/i);
        if (m) c = parse(m[1]);
      }
      if (c[3] > 0) acc = acc ? over(acc, c) : c;
      if (acc && acc[3] >= 0.999) return acc;
      node = node.parentElement;
    }
    return acc || [255, 255, 255, 1];
  };

  const EMOJI = /\\p{Extended_Pictographic}/u;
  const results = { contrast: [], tap: [], position: [] };
  const seen = new Set();

  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    // --- コントラスト -------------------------------------------------
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join('');
    // §7-2：絵文字はフォント自身の色で描かれ CSS の color が効かないので除外
    // §7-2：使用不可（disabled）は WCAG の対象外
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
      || cs.cursor === 'not-allowed';
    if (text && !EMOJI.test(text) && !disabled) {
      const fg = parse(cs.color);
      const bg = effectiveBg(el);
      if (fg[3] > 0) {
        const r = ratio(over(fg, bg), bg);
        const px = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = px >= 24 || (px >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        if (r < need) {
          const key = el.tagName + '|' + cs.color + '|' + text.slice(0, 20);
          if (!seen.has(key)) {
            seen.add(key);
            results.contrast.push({
              text: text.slice(0, 40), color: cs.color, bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')',
              ratio: +r.toFixed(2), need, fontSize: px, cls: (el.className || '').toString().slice(0, 90),
            });
          }
        }
      }
    }

    // --- 位置指定が奪われていないか ------------------------------------
    // 自分で足したクラス（.tap-44 など）が Tailwind の位置指定より後ろに並ぶと、
    // position を奪って要素が思わぬ場所へ飛ぶ。
    // 大きさも色も正常なので、数字の計測では絶対に気づけない。
    {
      const cls = (el.className || '').toString();
      for (const [name, want] of [['absolute', 'absolute'], ['fixed', 'fixed'], ['sticky', 'sticky']]) {
        if (!new RegExp('(^|\\\\s)' + name + '(\\\\s|$)').test(cls)) continue;
        if (cs.position === want) continue;
        const key = 'pos|' + cls.slice(0, 60);
        if (seen.has(key)) break;
        seen.add(key);
        results.position.push({
          expected: want, actual: cs.position,
          cls: cls.slice(0, 100),
          text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30),
        });
        break;
      }
    }

    // --- タップ領域 ----------------------------------------------------
    const tappable = ['BUTTON', 'A', 'SELECT'].includes(el.tagName)
      || (el.tagName === 'INPUT' && ['button', 'submit', 'checkbox', 'radio', 'file'].includes(el.type))
      || el.getAttribute('role') === 'button'
      || el.hasAttribute('onclick');
    if (tappable) {
      // §2-9：::after で当たり判定だけ広げる手を使うので、疑似要素も含めて測る
      let w = rect.width, h = rect.height;
      for (const pe of ['::after', '::before']) {
        const p = getComputedStyle(el, pe);
        if (p.content === 'none') continue;
        const pw = parseFloat(p.width), ph = parseFloat(p.height);
        const mw = parseFloat(p.minWidth), mh = parseFloat(p.minHeight);
        if (p.position === 'absolute') {
          if (!Number.isNaN(pw)) w = Math.max(w, Number.isNaN(mw) ? pw : Math.max(pw, mw));
          if (!Number.isNaN(ph)) h = Math.max(h, Number.isNaN(mh) ? ph : Math.max(ph, mh));
        }
      }
      // ラベルで囲われた input はラベル側の大きさで判定する（§2-9）
      const label = el.closest('label');
      if (label && label !== el) {
        const lr = label.getBoundingClientRect();
        w = Math.max(w, lr.width); h = Math.max(h, lr.height);
      }
      if (w < 44 || h < 44) {
        const key = 'tap|' + el.tagName + '|' + (el.className || '').toString().slice(0, 40) + '|' + (el.textContent || '').trim().slice(0, 16);
        if (!seen.has(key)) {
          seen.add(key);
          results.tap.push({
            tag: el.tagName, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30),
            w: +w.toFixed(1), h: +h.toFixed(1), cls: (el.className || '').toString().slice(0, 90),
          });
        }
      }
    }
  }
  return results;
})()`;

// ---------------------------------------------------------------------------
// 種データ。IndexedDB が空だと一覧・詳細・統計が「空状態」しか出ず、
// いちばん面積の広い画面を測れない。
// ---------------------------------------------------------------------------
const SEED = /* js */ `(async () => {
  // 1x1 の JPEG（data URL）。写真そのものは測定対象ではないので最小で足りる。
  const PIX = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('GigaClosetDB', 2);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const names = ['白シャツ', '黒デニム', 'ネイビージャケット', 'グレーニット', '茶ブーツ'];
  const cats  = ['トップス', 'ボトムス', 'アウター', 'トップス', '靴'];
  const cols  = ['ホワイト', 'ブラック', 'ネイビー', 'グレー', 'ブラウン'];
  const now = Date.now();
  const put = (store, v) => new Promise((res) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(v);
    tx.oncomplete = res; tx.onerror = res;
  });
  for (let i = 0; i < names.length; i++) {
    await put('items', {
      id: 'seed-' + i, name: names[i], category: cats[i], color: cols[i],
      brand: 'テストブランド', memo: '実測用の見本データ',
      seasons: ['春', '秋'], imageUrl: PIX, images: [PIX],
      createdAt: now - i * 86400000, disposedAt: i === 4 ? now : null,
    });
  }
  for (let i = 0; i < 6; i++) {
    const d = new Date(now - i * 86400000);
    await put('wear_logs', { id: 'seedlog-' + i, itemId: 'seed-' + (i % 3),
      date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
      createdAt: now - i * 86400000 });
  }
  await put('coordinates', { id: 'seedcoord-0', itemIds: ['seed-0', 'seed-1'],
    rating: 4, reason: '見本', createdAt: now });
  db.close();
  return true;
})()`;

async function main() {
  const browser = await chromium.launch();
  const report = { url: URL_ARG, screens: [], errors: [], csp: [], failed: [], pwa: {}, overflow: {} };

  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },        // Chromebook（GIGA標準機）
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  let navigations = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
  page.on('pageerror', (e) => report.errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) report.csp.push(t.slice(0, 300));
    else if (m.type() === 'error') report.errors.push(t.slice(0, 300));
  });
  page.on('requestfailed', (r) => report.failed.push(r.url().slice(0, 160) + ' :: ' + (r.failure()?.errorText || '')));

  await page.goto(URL_ARG, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // §7-5：まっさらな状態で1回開き、画面遷移を数える。1回なら正常。
  report.pwa.firstVisitNavigations = navigations;
  report.pwa.swRegistered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no-api';
    const r = await navigator.serviceWorker.getRegistration();
    return r ? (r.active ? 'active' : r.installing ? 'installing' : 'waiting') : false;
  });

  // 空の状態のままでは「一覧・詳細・統計」が測れない。
  // §2-8 の通り案内・空状態も測りたいので、空で1周してから種を入れてもう1周する。
  await page.evaluate(SEED);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 主要画面を歩く（§7-1 手順3「操作して測る」）
  const TABS = [
    ['クローゼット', null],
    ['コーデ', '[aria-label="コーデタブ"]'],
    ['カレンダー', '[aria-label="カレンダータブ"]'],
    ['ダッシュボード', '[aria-label="ダッシュボードタブ"]'],
    ['設定', '[aria-label="設定タブ"]'],
  ];

  for (const [name, sel] of TABS) {
    try {
      if (sel) {
        await page.locator(sel).first().click({ timeout: 5000 });
        await page.waitForTimeout(700);
      }
      const r = await page.evaluate(SCAN);
      report.screens.push({ name, contrast: r.contrast, tap: r.tap, position: r.position });
    } catch (e) {
      report.screens.push({ name, skipped: String(e).slice(0, 120) });
    }
  }

  // サブ画面（ヘッダーのボタン・設定からの遷移）。ここが漏れやすい。
  const SUBS = [
    ['アイテム追加', async () => {
      await page.locator('[aria-label="クローゼットタブ"]').click();
      await page.locator('[aria-label="アイテムを追加する"]').click();
    }],
    ['アイテム詳細', async () => {
      await page.locator('[aria-label="クローゼットタブ"]').click();
      await page.waitForTimeout(400);
      await page.locator('main .grid > *').first().click();
    }],
    ['廃棄済み', async () => {
      await page.locator('[aria-label="設定タブ"]').click();
      await page.waitForTimeout(400);
      await page.getByText('廃棄済みアイテム', { exact: false }).first().click();
    }],
    ['AI相談室', async () => {
      await page.locator('[aria-label="クローゼットタブ"]').click();
      await page.waitForTimeout(300);
      await page.locator('[aria-label="AI相談室を開く"]').click();
    }],
  ];

  for (const [name, go] of SUBS) {
    try {
      // 戻れるときは戻ってからにする（サブ画面の入れ子で迷子にならないように）
      const back = page.locator('[aria-label="戻る"]');
      if (await back.count()) { await back.first().click(); await page.waitForTimeout(400); }
      await go();
      await page.waitForTimeout(900);
      const r = await page.evaluate(SCAN);
      report.screens.push({ name, contrast: r.contrast, tap: r.tap, position: r.position });
    } catch (e) {
      report.screens.push({ name, skipped: String(e).slice(0, 160) });
    }
  }

  // 元の画面に戻してから幅の確認へ
  try {
    const back = page.locator('[aria-label="戻る"]');
    if (await back.count()) await back.first().click();
    await page.locator('[aria-label="クローゼットタブ"]').click();
    await page.waitForTimeout(400);
  } catch { /* 戻れなくても幅の測定はできる */ }

  // §2-1 設計の下限：320×568 で横スクロールが出ないこと
  for (const [w, h] of [[320, 568], [375, 667]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    report.overflow[`${w}x${h}`] = await page.evaluate(() => {
      const de = document.documentElement;
      const wide = [];
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > de.clientWidth + 1) {
          wide.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), right: Math.round(r.right) });
        }
      }
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
               overflow: de.scrollWidth > de.clientWidth + 1, offenders: wide.slice(0, 8) };
    });
  }

  await browser.close();

  const totals = report.screens.reduce((a, s) => {
    a.contrast += s.contrast?.length || 0;
    a.tap += s.tap?.length || 0;
    a.position += s.position?.length || 0;
    return a;
  }, { contrast: 0, tap: 0, position: 0 });
  report.totals = totals;

  mkdirSync('tools/out', { recursive: true });
  writeFileSync('tools/out/measure.json', JSON.stringify(report, null, 2));

  console.log('==== GIGA v5 実測 ====');
  console.log('URL:', URL_ARG);
  console.log('コントラスト基準未満:', totals.contrast, '件');
  console.log('タップ44px未満     :', totals.tap, '件');
  console.log('位置指定が奪われた :', totals.position, '件');
  console.log('JS エラー          :', report.errors.length, '件');
  console.log('CSP 違反           :', report.csp.length, '件');
  console.log('読み込み失敗       :', report.failed.length, '件');
  console.log('SW 登録            :', report.pwa.swRegistered);
  console.log('初回の画面遷移     :', report.pwa.firstVisitNavigations, '回（1回なら正常）');
  for (const [k, v] of Object.entries(report.overflow)) {
    console.log(`横スクロール ${k}   :`, v.overflow ? `あり (${v.scrollWidth}px)` : 'なし');
  }
  for (const s of report.screens) {
    if (s.skipped) { console.log(`\n[${s.name}] スキップ: ${s.skipped}`); continue; }
    if (!s.contrast.length && !s.tap.length && !s.position.length) { console.log(`\n[${s.name}] 0件`); continue; }
    console.log(`\n[${s.name}] contrast ${s.contrast.length} / tap ${s.tap.length} / position ${s.position.length}`);
    for (const p of s.position.slice(0, 8)) console.log(`   position: ${p.expected} のはずが ${p.actual} "${p.text}" ${p.cls}`);
    for (const c of s.contrast.slice(0, 12)) console.log(`   比 ${c.ratio} (要 ${c.need}) ${c.color} on ${c.bg} "${c.text}" ${c.cls}`);
    for (const t of s.tap.slice(0, 12)) console.log(`   ${t.w}x${t.h} <${t.tag}> "${t.label}" ${t.cls}`);
  }
  console.log('\n→ tools/out/measure.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
