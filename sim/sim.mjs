#!/usr/bin/env node
// Node simulator CLI. [Role 2]  Produces the CSV that Role 1 turns into the resilience chart.
//
//   node sim/sim.mjs                         full grid -> sim/out/results.csv + summary.csv
//   node sim/sim.mjs --seeds 2 --scenes 40   quick run
//   node sim/sim.mjs --agents web/data/agents.json --eval sim/data/scenes_eval.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOne, GRID } from './engine.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const agentsPath = resolve(ROOT, args.agents ?? 'web/data/agents.json');
const evalPath = resolve(ROOT, args.eval ?? 'sim/data/scenes_eval.json');
const outDir = resolve(ROOT, args.out ?? 'sim/out');
const seeds = Number(args.seeds ?? GRID.seeds);

const data = JSON.parse(readFileSync(agentsPath, 'utf8'));
let scenes = JSON.parse(readFileSync(evalPath, 'utf8'));
if (args.scenes) scenes = scenes.slice(0, Number(args.scenes));
if (data.fake) console.warn('WARNING: agents.json is FAKE data — numbers are for plumbing only.');

const rows = [];
const t = Date.now();
for (const method of GRID.methods) {
  for (const loss of GRID.losses) {
    for (const rogue of GRID.rogue) {
      for (let seed = 0; seed < seeds; seed++) {
        rows.push(runOne({ data, scenes, method, loss, rogue, seed }));
      }
    }
  }
  console.log(`${method} done (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}

const cols = Object.keys(rows[0]);
const fmt = (v) => (v === null ? '' : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(5) : String(v));
const toCsv = (rs, cs) => [cs.join(','), ...rs.map((r) => cs.map((c) => fmt(r[c])).join(','))].join('\n') + '\n';

// Summary: mean over seeds per (method, loss, rogue).
const metrics = ['accuracy', 'mode_accuracy', 'agreement', 'consonance', 'prediction_match',
  'detect_first_bars', 'detect_all_bars', 'false_positive_flags'];
const groups = new Map();
for (const r of rows) {
  const k = `${r.method}|${r.loss}|${r.rogue}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const summary = [...groups.values()].map((g) => {
  const out = { method: g[0].method, loss: g[0].loss, rogue: g[0].rogue, runs: g.length };
  for (const m of metrics) {
    const vals = g.map((r) => r[m]).filter((v) => v !== null);
    out[m] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    if (m === 'detect_first_bars' || m === 'detect_all_bars') out[`${m}_max`] = vals.length ? Math.max(...vals) : null;
  }
  return out;
});

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'results.csv'), toCsv(rows, cols));
writeFileSync(resolve(outDir, 'summary.csv'), toCsv(summary, Object.keys(summary[0])));
console.log(`\n${rows.length} runs over ${scenes.length} scenes -> ${outDir}`);
console.table(
  summary.map((s) => ({
    method: s.method, loss: s.loss, rogue: s.rogue,
    acc: s.accuracy?.toFixed(3), agree: s.agreement?.toFixed(3), cons: s.consonance?.toFixed(3),
    pred: s.prediction_match?.toFixed(3), det: s.detect_all_bars_max, fp: s.false_positive_flags,
  })),
);
