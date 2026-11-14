// Perception: raw embedding -> common frame -> (valence, arousal) -> (mode, density). [Role 2]
// Pure. Must match ml/fit_align.py + ml/export.py exactly (checked against data/testvectors.json).
//
//   z     = ((x - mu) @ W) @ R          (R_random instead of R for the control)
//   u     = z / |z|
//   v_raw = mean(u . valence_pos) - mean(u . valence_neg)     (anchors are unit length)
//   a_raw = mean(u . arousal_pos) - mean(u . arousal_neg)
//   v     = (v_raw - val_mean) / val_std,  a likewise with aro_*
//   level = 0 if s < lo, 1 if lo <= s < hi, 2 if s >= hi      (thresholds [lo, hi])
//   mode  = ['aeolian', 'dorian', 'ionian'][valenceLevel];  density = arousalLevel + 1

import { matrix, vecMat, sub, normalise, meanDot } from './linalg.js';

export const MODE_BY_LEVEL = ['aeolian', 'dorian', 'ionian']; // low / mid / high valence

export function prepareParams(p) {
  if (!p || !p.W) throw new Error('prepareParams: missing agent params');
  const W = matrix(p.W);
  if (W.rows !== p.dim) throw new Error(`prepareParams: W has ${W.rows} rows, dim is ${p.dim}`);
  return {
    dim: p.dim,
    mu: Float64Array.from(p.mu),
    W,
    R: matrix(p.R),
    R_random: p.R_random ? matrix(p.R_random) : null,
    val_mean: p.val_mean ?? 0,
    val_std: p.val_std || 1,
    aro_mean: p.aro_mean ?? 0,
    aro_std: p.aro_std || 1,
  };
}

export function prepareAnchors(a) {
  const prep = (rows) => rows.map((r) => normalise(Float64Array.from(r)));
  return {
    valence_pos: prep(a.valence_pos),
    valence_neg: prep(a.valence_neg),
    arousal_pos: prep(a.arousal_pos),
    arousal_neg: prep(a.arousal_neg),
  };
}

/** z = ((x - mu) @ W) @ R, not normalised. */
export function embed(prep, x, useRandomRotation = false) {
  if (x.length !== prep.dim) throw new Error(`embed: view has ${x.length} dims, expected ${prep.dim}`);
  const R = useRandomRotation ? prep.R_random : prep.R;
  if (!R) throw new Error('embed: R_random missing from agents.json');
  return vecMat(vecMat(sub(x, prep.mu), prep.W), R);
}

export function moodScores(prep, anchors, z) {
  const u = normalise(z);
  const valenceRaw = meanDot(u, anchors.valence_pos) - meanDot(u, anchors.valence_neg);
  const arousalRaw = meanDot(u, anchors.arousal_pos) - meanDot(u, anchors.arousal_neg);
  return {
    valenceRaw,
    arousalRaw,
    valence: (valenceRaw - prep.val_mean) / prep.val_std,
    arousal: (arousalRaw - prep.aro_mean) / prep.aro_std,
  };
}

/** Tertile level with no memory. */
export function level(score, [lo, hi]) {
  if (score < lo) return 0;
  if (score < hi) return 1;
  return 2;
}

/**
 * Tertile level with hysteresis: stay at `prev` unless the score leaves prev's band
 * by more than h. Then jump to wherever the score now is (can skip a level).
 */
export function levelWithHysteresis(score, thresholds, h, prev) {
  if (prev === null || prev === undefined) return level(score, thresholds);
  const [lo, hi] = thresholds;
  const lower = prev === 0 ? -Infinity : prev === 1 ? lo : hi;
  const upper = prev === 0 ? lo : prev === 1 ? hi : Infinity;
  if (score > upper + h || score < lower - h) return level(score, thresholds);
  return prev;
}

export function contextFromLevels(valenceLevel, arousalLevel) {
  return { mode: MODE_BY_LEVEL[valenceLevel], density: arousalLevel + 1 };
}
