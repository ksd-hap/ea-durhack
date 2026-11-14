// paint.js — canvas layers and brushes. [Role 4 OWNS THIS FILE]
//
// Placeholder. Inputs (all from ea-telemetry, see CONTRACTS.md):
//   {type:'note', from, at, bar, beat, pitch, vel, dur, role, rogue}   -> strokes on that agent's layer
//   {type:'ctx', from, bar, mode, density}                             -> that agent's palette
//   {type:'ghost', from, about, bar, beat, pitch}                      -> grey dashed underdrawing
//   {type:'status', from, bar, response: 'normal'|'absorb'|'defend', flagged: [...]} -> kintsugi on 'absorb'
// 1920x1080, one offscreen canvas per agent, painter's order: Architect, Weaver, Melodist, Pulse/Melkor, ghosts.

export function createPainter(/* canvas */) {
  return {
    onTelemetry(/* msg */) {},
    exportPng() {},
  };
}
