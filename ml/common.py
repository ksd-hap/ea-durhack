"""Shared settings and helpers for the Role 1 pipeline.

Pipeline (run from the repo root with the ML venv's python):
    python -m ml.prepare      split COCO val2017 (seed 0) and download the images
    python -m ml.embed        each agent's own encoder on its own view, plus truth
    python -m ml.fit_align    PCA+whitening per agent, Procrustes to Poet-A, ridge, R_random
    python -m ml.eval         held-out metrics, G1 decision, results.md + chart
    python -m ml.export       web/data/*.json, sim/data/scenes_eval.json, testvectors

Caches (images, .npy) live OUTSIDE the repo: $EA_CACHE or ~/.cache/ea-durhack.
"""

import json
import os
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get("EA_CACHE", Path.home() / ".cache" / "ea-durhack"))
IMAGES = CACHE / "images"
CAPTIONS = ROOT / "ml" / "coco" / "annotations" / "captions_val2017.json"
ARTIFACTS = ROOT / "ml" / "artifacts"

SEED = 0
K = 32
N_CAL, N_EVAL, N_CANDIDATES, N_DEMO = 600, 200, 400, 48
AGENTS = ["eyeA", "poetA", "eyeB", "poetB"]
MODES = ["aeolian", "dorian", "ionian"]  # valence level 0 / 1 / 2
DEC = 5

MODELS = {
    "eyeA": "facebook/dinov2-small",
    "eyeB": "resnet50",  # timm, ImageNet-supervised (resnet50.a1_in1k), num_classes=0
    "poetA": "sentence-transformers/all-mpnet-base-v2",
    "poetB": "sentence-transformers/all-MiniLM-L6-v2",
}

# Caption keywords for the demo candidate pool (moods only; never agent agreement).
MOOD_KEYWORDS = [
    "beach", "snow", "sunset", "sunrise", "night", "crowd", "crowded", "market", "rain", "storm",
    "empty", "party", "celebration", "festival", "wedding", "dark", "fog", "foggy", "busy", "traffic",
    "quiet", "alone", "lonely", "playing", "concert", "parade", "lake", "field", "mountain", "winter",
]

# ~6 short phrases per pole, encoded by Poet-A (mpnet) into the common frame.
ANCHOR_PHRASES = {
    "valence_pos": [
        "a joyful, sunny celebration", "happy people laughing together", "a bright, cheerful, colourful day",
        "a beautiful warm summer afternoon", "friends having fun at a party", "a delightful, pleasant scene",
    ],
    "valence_neg": [
        "a gloomy, lonely, grey place", "a sad, abandoned, broken building", "a dark, cold, miserable day",
        "a dreary, dirty, rundown street", "a bleak and depressing scene", "a lonely figure in the rain",
    ],
    "arousal_pos": [
        "a busy, energetic, crowded scene", "people running and jumping with excitement",
        "a loud, chaotic, bustling street", "fast action in an intense sports game",
        "a wild party with dancing", "heavy traffic racing through the city",
    ],
    "arousal_neg": [
        "a calm, still, empty scene", "a peaceful, quiet, sleepy room", "a serene, motionless lake",
        "a single object resting on a table", "a tranquil, silent landscape", "someone relaxing alone",
    ],
}


def scene_id(image_id: int) -> str:
    return f"coco_{image_id:012d}"


def load_manifest():
    return json.loads((CACHE / "manifest.json").read_text())


def save_json(path: Path, obj, compact=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"))
        else:
            json.dump(obj, f, indent=2)


def unit_rows(m):
    n = np.linalg.norm(m, axis=-1, keepdims=True)
    return m / np.where(n == 0, 1, n)


def level(s, lo, hi):
    """0 if s < lo, 1 if lo <= s < hi, 2 if s >= hi (same convention as web/core/perception.js)."""
    s = np.asarray(s)
    return np.where(s < lo, 0, np.where(s < hi, 1, 2))
