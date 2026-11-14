// Stress probe for absorb vs Melkor detection (Role 2). Usage:
//   node tools/absorb_stress.mjs "[0, 0.25, 0.5, 0.75, 0.9]" 30
// Prints false flags of honest agents and Melkor's detection latency per loss level.
import { readFileSync } from 'node:fs';
import { runOne } from '../sim/engine.mjs';
import { compose as placeholder } from '../web/core/compose.js';
import { absPc } from '../web/core/theory.js';
const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
const scenes = JSON.parse(readFileSync(new URL('../sim/data/scenes_eval.json', import.meta.url), 'utf8')).slice(0, 12);
const ANSWER = { 3: [3, 7, 10], 8: [4, 8, 11, 2] };
const RANGE = { architect: [50, 62], melodist: [62, 74], weaver: [57, 69], pulse: [74, 86] };
const absorbing = (a) => {
  if (a.rogue || !a.absorb) return placeholder(a);
  const pcs = new Set(a.absorb.pcs.flatMap((pc) => ANSWER[pc] ?? []));
  const [lo, hi] = RANGE[a.role]; const pool = [];
  for (let p = lo; p <= hi; p++) if (pcs.has(absPc(p))) pool.push(p);
  return { notes: [0, 1, 2, 3].map((beat) => ({ beat, pitch: pool[Math.floor(a.rng() * pool.length)], dur: 1, vel: 0.6 })), state: a.state };
};
for (const loss of (process.argv[2] ? JSON.parse(process.argv[2]) : [0, 0.25, 0.5])) {
  let runsWithFp = 0, fp = 0, det = [];
  for (let seed = 0; seed < (Number(process.argv[3]) || 10); seed++) {
    const r = runOne({ data, scenes, method: 'ea', loss, rogue: true, seed, compose: absorbing });
    fp += r.false_positive_flags; if (r.false_positive_flags) runsWithFp++; det.push(r.detect_all_bars);
  }
  console.log(`loss ${loss}: runs with honest agents flagged ${runsWithFp}/${Number(process.argv[3]) || 10}, false flags ${fp}, Melkor all-flagged latency ${det.join(',')}`);
}
