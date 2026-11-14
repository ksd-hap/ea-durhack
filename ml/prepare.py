"""Split COCO val2017 into disjoint calibration / evaluation / demo-candidate sets and download
only those images (not the 1 GB zip).

Splits (seed 0, image-disjoint): shuffle every image with >= 5 captions; the first 600 are
calibration, the next 200 held-out evaluation. Demo candidates are the first 400 REMAINING
images whose captions contain a mood keyword. The 48 demo scenes are picked later from those
candidates by caption-based truth only (ml/export.py), never by agent agreement.

    python -m ml.prepare [--workers 16]
"""

import argparse
import json
import re
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

from ml.common import CACHE, CAPTIONS, IMAGES, MOOD_KEYWORDS, N_CAL, N_CANDIDATES, N_EVAL, SEED, scene_id


def build_manifest():
    coco = json.loads(CAPTIONS.read_text(encoding="utf-8"))
    caps = {}
    for a in sorted(coco["annotations"], key=lambda a: a["id"]):  # stable caption order
        caps.setdefault(a["image_id"], []).append(a["caption"].strip())
    images = {im["id"]: im for im in coco["images"]}
    ids = sorted(i for i, c in caps.items() if len(c) >= 5)
    order = np.random.default_rng(SEED).permutation(len(ids))
    shuffled = [ids[i] for i in order]

    cal, ev = shuffled[:N_CAL], shuffled[N_CAL : N_CAL + N_EVAL]
    kw = re.compile(r"\b(" + "|".join(MOOD_KEYWORDS) + r")\b", re.I)
    cand = [i for i in shuffled[N_CAL + N_EVAL :] if any(kw.search(c) for c in caps[i][:5])][:N_CANDIDATES]
    assert len(cand) == N_CANDIDATES, f"only {len(cand)} keyword candidates"
    assert not (set(cal) & set(ev)) and not (set(cand) & (set(cal) | set(ev)))

    rows = []
    for split, group in (("calibration", cal), ("evaluation", ev), ("candidate", cand)):
        for i in group:
            rows.append({
                "image_id": i,
                "id": scene_id(i),
                "split": split,
                "url": images[i]["coco_url"],
                "file": f"{scene_id(i)}.jpg",
                "captions": caps[i][:5],
            })
    return rows


def download(row):
    path = IMAGES / row["file"]
    if path.exists() and path.stat().st_size > 0:
        return 0
    r = requests.get(row["url"], timeout=60)
    r.raise_for_status()
    tmp = path.with_suffix(".part")
    tmp.write_bytes(r.content)
    tmp.replace(path)
    return len(r.content)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=16)
    a = ap.parse_args()
    IMAGES.mkdir(parents=True, exist_ok=True)
    rows = build_manifest()
    (CACHE / "manifest.json").write_text(json.dumps(rows))
    counts = {s: sum(r["split"] == s for r in rows) for s in ("calibration", "evaluation", "candidate")}
    print(f"manifest: {counts} -> {CACHE / 'manifest.json'}")
    with ThreadPoolExecutor(a.workers) as ex:
        got = list(ex.map(download, rows))
    print(f"downloaded {sum(g > 0 for g in got)} new images ({sum(got) / 1e6:.1f} MB); "
          f"{len(rows)} total in {IMAGES}")


if __name__ == "__main__":
    main()
