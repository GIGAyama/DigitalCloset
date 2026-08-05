#!/usr/bin/env node
/**
 * GIGA Standard v5 §2-6 / §3-2 / §3-7 アイコン生成
 *
 * 原本 : tools/src-icon.png（1枚だけ。ここを差し替えれば全部作り直せる）
 * 生成先: public/icons/ と public/favicon.png（生成物。手で編集しない）
 *
 * ここでやっていること
 *   1. パレット PNG 化（§2-6）。色数の少ない絵をフルカラーで持つ理由はない
 *   2. apple-touch-icon から透明を落とす（§3-2）
 *      iOS は透明部分を黒で埋めるため、ホーム画面で四隅だけが黒く出る
 *   3. maskable は「下地を端まで伸ばす」（§3-7）
 *      余白を付けると欠けはしないが、切り抜きの内側が余白色で埋まって縮んで見える
 *   4. 作ったあと、セーフゾーン外の「中身」を画素で数えて確かめる（目標 0.2% 以下）
 */
import sharp from 'sharp';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const SRC = 'tools/src-icon.png';
const OUT = 'public/icons';

if (!existsSync(SRC)) {
  console.error(`原本が見つからない: ${SRC}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// 下地（背景のグラデーション）を原本から取り出す。
// §3-7：単色のグラデーションを敷くと角丸四角の輪郭が薄い影として残る。
// 元の絵の下地は左上が明るく右下が暗いので、実際の画素を読んで同じ向きに作る。
// ---------------------------------------------------------------------------
async function sampleBackdrop() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const at = (x, y) => {
    const i = (y * W + x) * C;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };

  // 角丸の内側で、かつ絵の中身（白いハンガー・黄色い星）から離れた点を選ぶ。
  // 左右の縁の帯は下地しか無いので、そこを縦に舐めて明暗の両端を拾う。
  const band = [];
  for (let y = Math.round(H * 0.12); y < H * 0.88; y += 4) {
    for (const x of [Math.round(W * 0.06), Math.round(W * 0.94)]) {
      const p = at(x, y);
      if (p[3] > 250) band.push({ x, y, p });
    }
  }
  if (!band.length) throw new Error('下地の画素を拾えなかった');

  // 左上から右下へ向かう対角線上の位置で並べ、両端を代表色にする
  band.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const avg = (arr) => arr.reduce((s, o) => [s[0] + o.p[0], s[1] + o.p[1], s[2] + o.p[2]], [0, 0, 0])
    .map((v) => Math.round(v / arr.length));
  const n = Math.max(3, Math.round(band.length * 0.15));
  const light = avg(band.slice(0, n));
  const dark = avg(band.slice(-n));
  // 中間も拾っておくと、実際の非線形なグラデーションに寄る
  const mid = avg(band.slice(Math.round(band.length / 2 - n / 2), Math.round(band.length / 2 + n / 2)));
  return { light, mid, dark };
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** 端まで伸びた下地。原本と同じ左上→右下の向きで作る。 */
const backdropSvg = (size, { light, mid, dark }) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
     <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
       <stop offset="0%"   stop-color="${rgb(light)}"/>
       <stop offset="50%"  stop-color="${rgb(mid)}"/>
       <stop offset="100%" stop-color="${rgb(dark)}"/>
     </linearGradient></defs>
     <rect width="${size}" height="${size}" fill="url(#g)"/>
   </svg>`);

/**
 * 原本から「中身」だけを抜き出す（角丸四角の下地を落とす）。
 *
 * §3-7：下地を端まで伸ばすとき、角丸四角ごと重ねると輪郭が薄い影として残る。
 * 元の絵の下地は左上が明るく右下が暗いので、合成した単色グラデーションとは
 * どうしても僅かにずれ、その境目が線になって見える。
 * 下地そのものを持ち込まなければ、境目は生まれようがない。
 *
 * 中身（白いハンガー・シャツ・黄色い星）は青い下地から色が大きく離れているので、
 * その位置の下地色との距離を不透明度に変えるだけで抜ける。
 */
async function extractContent(size, backdrop) {
  const { data, info } = await sharp(SRC).resize(size, size).ensureAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const lerp = (a, b, t) => a + (b - a) * t;
  const out = Buffer.alloc(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C, o = (y * W + x) * 4;
      const t = (x / W + y / H) / 2;
      const b = [0, 1, 2].map((k) => (t < 0.5
        ? lerp(backdrop.light[k], backdrop.mid[k], t * 2)
        : lerp(backdrop.mid[k], backdrop.dark[k], (t - 0.5) * 2)));
      const d = Math.hypot(data[i] - b[0], data[i + 1] - b[1], data[i + 2] - b[2]);
      // しきい値は当てずっぽうではなく測って決めた。
      // 原本の下地はこの3点グラデーションから最大 42 ずれる（左上の明るい部分）。
      // 15 で切ると、そのずれが「中身」として残り、角丸四角の輪郭が薄く出る。
      // 中身の側はいちばん近いシャツの青い衿元でも 56 離れているので、45 で切り分く。
      const k = Math.min(1, Math.max(0, (d - 45) / 40));
      out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2];
      out[o + 3] = Math.round((data[i + 3] / 255) * k * k * (3 - 2 * k) * 255);
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

/**
 * パレット PNG で書き出す。
 * §2-6 の注意：sharp を通して書き直すとパレットが落ちる。作ったバッファをそのまま書く。
 * 色数は落としながら、いちばん軽くなった版を選ぶ。
 */
async function writePalette(pipeline, dest, tries = [32, 64, 128, 256]) {
  let best = null;
  for (const colours of tries) {
    const buf = await pipeline.clone()
      .png({ palette: true, colours, effort: 10, compressionLevel: 9 })
      .toBuffer();
    if (!best || buf.length < best.buf.length) best = { buf, colours };
  }
  writeFileSync(dest, best.buf);
  return { bytes: best.buf.length, colours: best.colours };
}

// ---------------------------------------------------------------------------
// §3-7 の確かめ方：中央80%の円の外側に「絵の中身」が何％あるかを画素で数える。
// 下地は切り抜かれてよいので、下地と中身を色で区別する。
// 一緒に数えると実態より深刻に見える。
// ---------------------------------------------------------------------------
async function measureSafeZone(file, backdrop) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const cx = W / 2, cy = H / 2, r = W * 0.4;          // 中央80%の円 = 半径 40%
  let outside = 0, content = 0;

  // 下地かどうかは、その位置のグラデーション色との距離で判定する
  const lerp = (a, b, t) => a + (b - a) * t;
  const backdropAt = (x, y) => {
    const t = (x / W + y / H) / 2;
    const pick = (i) => (t < 0.5
      ? lerp(backdrop.light[i], backdrop.mid[i], t * 2)
      : lerp(backdrop.mid[i], backdrop.dark[i], (t - 0.5) * 2));
    return [pick(0), pick(1), pick(2)];
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) continue;
      outside++;
      const i = (y * W + x) * C;
      if (data[i + 3] < 8) continue;                   // 透明は中身ではない
      const b = backdropAt(x, y);
      const d = Math.hypot(data[i] - b[0], data[i + 1] - b[1], data[i + 2] - b[2]);
      if (d > 60) content++;                           // 下地から離れていれば「中身」
    }
  }
  return { pct: +(content / outside * 100).toFixed(3), content, outside };
}

// ---------------------------------------------------------------------------

const rows = [];
const log = (name, bytes, note = '') => rows.push({ name, bytes, note });

const backdrop = await sampleBackdrop();
console.log('下地の代表色:', rgb(backdrop.light), '→', rgb(backdrop.mid), '→', rgb(backdrop.dark));

// --- purpose: "any"。角丸の外は透明のままでよい ---------------------------
for (const size of [192, 512]) {
  const p = sharp(SRC).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  const r = await writePalette(p, `${OUT}/icon-${size}.png`);
  log(`icons/icon-${size}.png`, r.bytes, `${r.colours}色`);
}

// --- purpose: "maskable"。下地を端まで伸ばし、中身はセーフゾーンへ収める ---
// 中央80%の円に収めるには、正方形の絵を 0.8/√2 ≒ 0.566 まで縮める必要がある。
// ただし絵の四隅は下地（切り抜かれてよい）なので、そこまで縮めると小さくなりすぎる。
// 実際に測って 0.2% 以下に収まる範囲で、いちばん大きい倍率を選ぶ。
for (const size of [192, 512]) {
  let chosen = null;
  for (const scale of [0.92, 0.88, 0.84, 0.80, 0.76, 0.72, 0.68]) {
    const inner = Math.round(size * scale);
    // 角丸の下地は持ち込まず、中身だけを重ねる（輪郭の影を出さないため）
    const art = await sharp(await extractContent(size, backdrop)).resize(inner, inner).png().toBuffer();
    const composed = sharp(backdropSvg(size, backdrop))
      .composite([{ input: art, left: Math.round((size - inner) / 2), top: Math.round((size - inner) / 2) }]);
    const tmp = `${OUT}/.maskable-${size}.tmp.png`;
    writeFileSync(tmp, await composed.clone().png().toBuffer());
    const m = await measureSafeZone(tmp, backdrop);
    if (m.pct <= 0.2) { chosen = { scale, m, composed }; break; }
    chosen = { scale, m, composed };   // どれも超えるなら最後の（いちばん小さい）を使う
  }
  const r = await writePalette(chosen.composed, `${OUT}/maskable-${size}.png`);
  const m = await measureSafeZone(`${OUT}/maskable-${size}.png`, backdrop);
  log(`icons/maskable-${size}.png`, r.bytes, `${r.colours}色 / 絵 ${Math.round(chosen.scale * 100)}% / セーフゾーン外 ${m.pct}%`);
}

// --- apple-touch-icon。透明を含んではいけない（§3-2）---------------------
// 角丸の外の透明を下地で埋める。iOS 側がさらに角丸に切るので、四隅は見えなくなる。
{
  const size = 180;
  const art = await sharp(SRC).resize(size, size).png().toBuffer();
  const p = sharp(backdropSvg(size, backdrop)).composite([{ input: art }]).flatten({ background: rgb(backdrop.mid) });
  const r = await writePalette(p, `${OUT}/apple-touch-icon.png`);
  const meta = await sharp(`${OUT}/apple-touch-icon.png`).stats();
  const hasAlpha = (await sharp(`${OUT}/apple-touch-icon.png`).metadata()).hasAlpha;
  const minAlpha = meta.channels[3] ? meta.channels[3].min : 255;
  log(`icons/apple-touch-icon.png`, r.bytes, `${r.colours}色 / 透明 ${hasAlpha && minAlpha < 255 ? '**あり（要修正）**' : 'なし'}`);
}

// --- favicon。1024 も 512 も要らない。256 で足りる（§2-6）-----------------
{
  const p = sharp(SRC).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  const r = await writePalette(p, 'public/favicon.png', [16, 32, 64, 128]);
  log('favicon.png', r.bytes, `${r.colours}色 / 256×256`);
}

// 一時ファイルを片づける
for (const size of [192, 512]) {
  try { (await import('node:fs')).unlinkSync(`${OUT}/.maskable-${size}.tmp.png`); } catch { /* 無ければよい */ }
}

console.log('\n| ファイル | サイズ | 備考 |');
console.log('|---|---:|---|');
let total = 0;
for (const r of rows) { total += r.bytes; console.log(`| \`${r.name}\` | ${(r.bytes / 1024).toFixed(1)} KB | ${r.note} |`); }
console.log(`| **合計** | **${(total / 1024).toFixed(1)} KB** | |`);
