# ml/ — Role 1: ML and alignment

Owns the claim that separately trained models share a frame. Produces `web/data/agents.json`, `web/data/scenes.json`, `web/data/testvectors.json`, `sim/data/scenes_eval.json` and `ml/results.md`.

Until real data lands, those files are **fake** (from `tools/make_fake_data.py`, marked `"fake": true`). Use that script as the reference for the exact output shapes and the maths conventions.

Pipeline (see the build plan): `embed.py`, then `fit_align.py`, then `eval.py`, then `export.py`. Split: 600 calibration, 200 held-out eval, about 48 demo scenes, all disjoint, seed 0.

Conventions Role 2's JS relies on (checked by `tests/linalg.test.mjs` and `web/dev/selftest.html`):

- `z = ((x - mu) @ W) @ R`, where `x` is a row vector, `W` is `dim x 32` (PCA plus whitening folded in) and `R` is `32 x 32`.
- Anchors are given in the common frame as unit-length rows. Scores use the **normalised** z: `valence_raw = mean(u·pos) - mean(u·neg)`.
- Standardise with each agent's own `val_mean/val_std/aro_mean/aro_std`.
- `level = 0 if s < lo; 1 if lo <= s < hi; 2 if s >= hi`. The mode is `['aeolian','dorian','ionian'][valenceLevel]` and the density is `arousalLevel + 1`.
- **Compute `testvectors.json` from the rounded (5 d.p.) params and views you export**, so the 1e-4 check tests arithmetic, not rounding.
- `testvectors.json` holds `[{agent, scene, x, z, valence_raw, arousal_raw, valence, arousal, context:{mode,density}}]`, where `z` is before normalising.

```
pip install -r ml/requirements.txt
```
