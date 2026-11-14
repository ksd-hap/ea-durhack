// Snapshot runOne() outputs for a fixed set of configs (regression baseline for refactors).
//   node tools/sim_snapshot.mjs out.json
import { readFileSync, writeFileSync } from 'node:fs';
import { runOne } from '../sim/engine.mjs';
const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
const scenes = JSON.parse(readFileSync(new URL('../sim/data/scenes_eval.json', import.meta.url), 'utf8')).slice(0, 40);
const out = [];
for (const method of ['ea', 'baseline', 'random'])
  for (const loss of [0, 0.5, 1])
    for (const rogue of [false, true])
      for (const seed of [0, 1]) out.push(runOne({ data, scenes, method, loss, rogue, seed }));
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(`${out.length} runs snapshotted`);
