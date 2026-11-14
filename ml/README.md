# ml/ — Role 1: ML and alignment

Owns the claim that separately trained models share a frame. **Results: [`results.md`](results.md)** (G1: PASS, Procrustes k = 32), with the slide chart in `artifacts/alignment.png` and every number in `artifacts/metrics.json`.

The real exports are in `web/data/agents.json`, `scenes.json`, `testvectors.json` and `provenance.json` (exact COCO ids per split), in `sim/data/scenes_eval.json`, and as thumbnails in `web/img/`.

## Re-running (about 6 minutes on a 16-core CPU)

```bash
python -m venv ~/.venvs/ea            # keep the venv OUT of OneDrive
~/.venvs/ea/Scripts/python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
~/.venvs/ea/Scripts/python -m pip install -r ml/requirements.txt
# COCO captions: annotations_trainval2017.zip -> ml/coco/annotations/captions_val2017.json (gitignored)
PY=~/.venvs/ea/Scripts/python
$PY ml/fetch_models.py            # cache the 4 models once; afterwards everything runs offline
$PY -m ml.prepare                 # split (seed 0) + download ~1200 images (~200 MB) to ~/.cache/ea-durhack
$PY -m ml.embed                   # each agent's own encoder on its own view, plus caption truth
$PY -m ml.fit_align               # PCA+whitening, Procrustes to Poet-A, ridge, R_random, anchors
$PY -m ml.eval                    # held-out metrics, G1 decision, results.md, chart
$PY -m ml.export                  # contract-format JSON + thumbnails + testvectors
node --test tests/                # includes JS-vs-NumPy parity on the new testvectors
node sim/sim.mjs                  # resilience grid on scenes_eval.json -> sim/out/
```

Caches (images, `.npy`, `fit.npz`) live outside the repo, in `$EA_CACHE` (default `~/.cache/ea-durhack`).

## Design

| Agent | Encoder | Its view |
|---|---|---|
| Eye-A | `facebook/dinov2-small`, CLS (384) | full image |
| Eye-B | timm `resnet50.a1_in1k` (ImageNet-supervised), pooled (2048) | seeded random crop, 70% of the area |
| Poet-A | `all-mpnet-base-v2` (768) | caption 1 of 5 (defines the common frame) |
| Poet-B | `all-MiniLM-L6-v2` (384) | caption 2 of 5 |

- **Splits.** 600 calibration, 200 held-out evaluation and a 400-image demo candidate pool (caption mood keywords). All are image-disjoint, with seed 0.
- **Demo scenes.** 48 scenes picked from the candidate pool by caption-based truth **only**, round-robin over the 9 (mode, density) cells, **clearest caption mood first**. Clarity is how far a scene's standardised truth scores sit inside their tertile band on both axes. Never chosen by agent agreement.
  - **Measured once, after the fact,** on the agents' JS perception: the old pool-order set gave 38.0% mood accuracy, 60.9% mode accuracy and 30.2% pairwise agreement; the clearest-first set gives 45.3%, 64.6% and 30.6%.
  - **The gain is mostly the poets.** Eye accuracy moved 39.6% → 36.5% (noise at n = 96), and agreement didn't change.
  - **Scene choice doesn't fix agreement.** Four independent agents, each right about half the time, rarely all agree. Pitch the resilience against truth, not unanimity.
- **Map.** `z = ((x - mu) @ W) @ R`. `W` is PCA to 32 with whitening folded in. `R` is orthogonal Procrustes to Poet-A on calibration. Ridge (alpha 10) is reported as a comparison; `R_random` is the control.
- **Statistics per method.** Score statistics are fitted per agent **and per method**, in `stats_by_method`. So the random-rotation control is standardised with its own statistics, in Python and in JS alike (`web/core/perception.js`).
- **Truth.** Poet-A's frame applied to the mean of all 5 MPNet caption embeddings. Standardised with its own calibration statistics and thresholded at Poet-A's tertiles.
- **Test vectors.** `testvectors.json` is computed from the rounded exported values, for both the fitted map and the random control. The JS matches it to about 1e-15.

## Cross-check

Ziad's independent Role 1 pipeline (Python 3.12, torch 2.7) reported:
- Eye-A / Eye-B mode accuracy of 48.5% / 51.0%, against 22.0% / 27.5% for the random control;
- R@1 of 27% / 23%;
- pairwise context agreement of 24.75%.

This rebuild (Python 3.14, torch 2.15) gets 53.5% / 53.5%, 39.5% / 26.5%, 22% / 20% and 25.4%. Two separately written pipelines agree.

## Honest limits
- Truth is a caption proxy, not human mood labels. The poets' accuracy is partly circular, because their captions are among the five; the eyes are the clean test.
- Agreement between agents is modest: about 25% exact context per pair, about 49% on mode alone. They agree far more than under the random control (13% / 34%), but far from always.
