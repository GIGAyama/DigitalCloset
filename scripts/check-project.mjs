#!/usr/bin/env node
/**
 * GIGA Standard v5 品質ゲート。
 *
 * CI（.github/workflows/ci.yml）と手元で同じものを走らせる。
 *   npm run check
 *
 * ここが見るのは「読めば分かること」だけである。
 * コントラスト・タップ領域・PWA の挙動・CSP が効いているかは読んでも分からないので、
 * tools/measure.mjs / measure-pwa.mjs / measure-csp.mjs で実ブラウザから測る。
 * このゲートが通ったことを「測った」と言わないこと。
 */
import { readFileSync, existsSync } from 'node:fs';
import { runGigaChecks, runBuildChecks } from './lib/giga-v5-checks.mjs';

const cfg = JSON.parse(readFileSync('quality.config.json', 'utf8'));

const results = [...runGigaChecks(cfg), ...runBuildChecks(cfg)];
const failed = results.filter((r) => !r.ok && r.severity !== 'warn');
const warned = results.filter((r) => !r.ok && r.severity === 'warn');

for (const r of results) {
  if (r.ok) console.log(`  ✅ ${r.id.padEnd(32)} ${r.message}`);
}
for (const r of warned) console.log(`  ⚠️  ${r.id.padEnd(32)} ${r.message}`);
for (const r of failed) console.log(`  ❌ ${r.id.padEnd(32)} ${r.message}`);

console.log(`\n${results.length - failed.length - warned.length}/${results.length} 項目`);

if (!existsSync('dist')) {
  console.log('※ dist/ が無いため、ビルド成果物の検査（初回JS・総アセット・sw.js の版）は走っていません。');
  console.log('  npm run build のあとに npm run check を走らせると全項目が動きます。');
}

console.log('\n【この検査が見ていないもの】測っていないものを ✅ と書かないための控え');
for (const line of [
  'コントラスト比（実ブラウザで全画面を走査：tools/measure.mjs）',
  'タップ領域 44px（疑似要素込みで実測：tools/measure.mjs）',
  'PWA の挙動（登録・初回リロード・更新・他アプリのキャッシュ・圏外：tools/measure-pwa.mjs）',
  'CSP が実際に効いているか（tools/measure-csp.mjs）',
  'maskable のセーフゾーン（tools/build-icons.mjs が生成時に画素で数える）',
]) console.log(`  ・${line}`);

if (failed.length) {
  console.log(`\n❌ ${failed.length} 件が基準を満たしていません。`);
  process.exit(1);
}
console.log('\n✅ 静的検査はすべて通りました。');
