"""Each agent's OWN encoder on its OWN view of every scene, plus caption-based truth.

  Eye-A  facebook/dinov2-small, CLS token, on the full image             -> eyeA.npy  (N, 384)
  Eye-B  timm resnet50 (ImageNet), pooled, on a seeded 70%-area crop     -> eyeB.npy  (N, 2048)
  Poet-A all-mpnet-base-v2 on caption 1 of 5                             -> poetA.npy (N, 768)
  Poet-B all-MiniLM-L6-v2 on caption 2 of 5                              -> poetB.npy (N, 384)
  Truth  all-mpnet-base-v2, mean of all 5 caption embeddings             -> truth.npy (N, 768)

Rows follow manifest.json order. Runs offline once ml/fetch_models.py has cached the models.

    python -m ml.embed [--batch 32] [--threads 16]
"""

import argparse
import json
import time

import numpy as np
import torch
from PIL import Image

from ml.common import CACHE, IMAGES, MODELS, SEED, load_manifest

CROP_AREA = 0.70


def eyeb_crop(img, image_id):
    """Seeded random crop covering 70% of the area, same aspect ratio as the image."""
    w, h = img.size
    s = CROP_AREA ** 0.5
    cw, ch = max(1, round(w * s)), max(1, round(h * s))
    rng = np.random.default_rng([SEED, image_id])
    x = int(rng.integers(0, w - cw + 1))
    y = int(rng.integers(0, h - ch + 1))
    return img.crop((x, y, x + cw, y + ch)), [x, y, cw, ch]


def batches(n, size):
    for i in range(0, n, size):
        yield range(i, min(n, i + size))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--threads", type=int, default=16)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    torch.set_grad_enabled(False)
    rows = load_manifest()
    n = len(rows)
    out = {}

    from transformers import AutoImageProcessor, AutoModel
    import timm
    from sentence_transformers import SentenceTransformer

    t = time.time()
    proc = AutoImageProcessor.from_pretrained(MODELS["eyeA"])
    dino = AutoModel.from_pretrained(MODELS["eyeA"]).eval()
    rn = timm.create_model(MODELS["eyeB"], pretrained=True, num_classes=0).eval()
    tf = timm.data.create_transform(**timm.data.resolve_data_config({}, model=rn))
    eyeA, eyeB, crops = [], [], {}
    for idx in batches(n, a.batch):
        imgs = [Image.open(IMAGES / rows[i]["file"]).convert("RGB") for i in idx]
        eyeA.append(dino(**proc(images=imgs, return_tensors="pt")).last_hidden_state[:, 0].numpy())
        crop_imgs = []
        for i, im in zip(idx, imgs):
            c, box = eyeb_crop(im, rows[i]["image_id"])
            crops[rows[i]["id"]] = box
            crop_imgs.append(tf(c))
        eyeB.append(rn(torch.stack(crop_imgs)).numpy())
        print(f"  images {idx.stop}/{n}  ({time.time() - t:.0f}s)", end="\r", flush=True)
    out["eyeA"], out["eyeB"] = np.concatenate(eyeA), np.concatenate(eyeB)
    print(f"\nimage encoders done in {time.time() - t:.0f}s")

    t = time.time()
    mpnet = SentenceTransformer(MODELS["poetA"], device="cpu")
    minilm = SentenceTransformer(MODELS["poetB"], device="cpu")
    out["poetA"] = mpnet.encode([r["captions"][0] for r in rows], batch_size=64)
    out["poetB"] = minilm.encode([r["captions"][1] for r in rows], batch_size=64)
    all5 = mpnet.encode([c for r in rows for c in r["captions"][:5]], batch_size=64)
    out["truth"] = all5.reshape(n, 5, -1).mean(1)
    print(f"text encoders done in {time.time() - t:.0f}s")

    for k, v in out.items():
        v = np.asarray(v, dtype=np.float32)
        assert v.shape[0] == n and np.isfinite(v).all(), k
        np.save(CACHE / f"{k}.npy", v)
        print(f"  {k:6s} {v.shape}")
    (CACHE / "crops.json").write_text(json.dumps(crops))
    versions = {"torch": torch.__version__, "timm": timm.__version__}
    import transformers, sentence_transformers
    versions.update(transformers=transformers.__version__, sentence_transformers=sentence_transformers.__version__)
    (CACHE / "embed_versions.json").write_text(json.dumps(versions))


if __name__ == "__main__":
    main()
