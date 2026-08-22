#!/usr/bin/env node
/**
 * 品質ゲート。CI と同じものを手元でも回せる。
 *
 *   npm run check
 *
 * 構成:
 *   scripts/lib/giga-v5-checks.mjs … 共通の検査の【正本】。
 *     GIGAyama.github.io/standards/lib/ からのコピーで、ここでは手を入れない。
 *     直すときは正本を直してから配る（drift ジョブがずれを見張っている）。
 *   scripts/lib/local-checks.mjs   … このリポジトリだけの検査。
 *
 * ここは「読めば分かること」だけを見る。コントラスト・タップ領域・
 * PWA の挙動・CSP が効いているかは読んでも分からないので
 * tools/measure*.mjs で実ブラウザから測る。
 * 静的検査が通ったことを「測った」と言わないこと。
 *
 * ⚠️ 検査そのものが壊れていないかは scripts/verify-gate.mjs が確かめる。
 *    「0件でした」だけでは、効いているのか何も見ていないのか区別できない。
 */
import { readFileSync } from 'node:fs';
import { runGigaChecks } from './lib/giga-v5-checks.mjs';
import { runLocalChecks, runBuildChecks } from './lib/local-checks.mjs';

const cfg = JSON.parse(readFileSync('quality.config.json', 'utf8'));

// 正本は { id, title, ok, detail, skipped } を返す。ローカルは
// { id, message, ok, severity }。出力をそろえてから並べる。
const fromCanonical = runGigaChecks('.', cfg.standard).map((r) => ({
  id: r.id,
  ok: r.ok,
  message: r.title,
  detail: r.detail || [],
  skipped: r.skipped,
  severity: 'error',
}));
const fromLocal = [...runLocalChecks(cfg), ...runBuildChecks(cfg)]
  .map((r) => ({ ...r, detail: [] }));

const results = [...fromCanonical, ...fromLocal];
const failed = results.filter((r) => !r.ok && !r.skipped && r.severity !== 'warn');
const warned = results.filter((r) => !r.ok && !r.skipped && r.severity === 'warn');

for (const r of results) {
  const mark = r.skipped ? '－' : r.ok ? '✅' : (r.severity === 'warn' ? '⚠️' : '❌');
  console.log(`  ${mark} ${r.id.padEnd(34)} ${r.message}`);
  for (const d of r.detail) console.log(`       ↳ ${d}`);
}

const ran = results.filter((r) => !r.skipped).length;
console.log(`\n合計 ${results.length} 件： 合格 ${ran - failed.length - warned.length} / 不合格 ${failed.length} / 対象外 ${results.length - ran}`);

console.log('\n【この検査が見ていないもの】測っていないものを ✅ と書かないための控え');
console.log('  ・コントラスト比（実ブラウザで全画面を走査：tools/measure.mjs）');
console.log('  ・タップ領域 44px（疑似要素込みで実測：tools/measure.mjs）');
console.log('  ・PWA の挙動（登録・初回リロード・更新・圏外：tools/measure-pwa.mjs）');
console.log('  ・CSP が実際に効いているか（tools/measure-csp.mjs）');

if (failed.length) process.exit(1);
console.log('\n✅ 静的検査はすべて通りました。');
