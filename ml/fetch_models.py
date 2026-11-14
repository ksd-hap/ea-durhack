"""Pre-download the four agents' encoders and smoke-test each one (Role 1).

Run once while there's network; afterwards everything loads from the local cache
(~/.cache/huggingface and ~/.cache/torch), so the pipeline works offline.

    python ml/fetch_models.py

Checks each model produces the embedding size the contract expects:
  Eye-A  facebook/dinov2-small, CLS token            384
  Eye-B  timm resnet50 (ImageNet), num_classes=0      2048
  Poet-A sentence-transformers/all-mpnet-base-v2      768
  Poet-B sentence-transformers/all-MiniLM-L6-v2       384
"""

import time

import numpy as np
import torch
from PIL import Image

EXPECTED = {"eyeA": 384, "eyeB": 2048, "poetA": 768, "poetB": 384}


def main():
    torch.set_grad_enabled(False)
    img = Image.fromarray((np.random.default_rng(0).random((224, 224, 3)) * 255).astype("uint8"))
    got = {}

    t = time.time()
    from transformers import AutoImageProcessor, AutoModel

    proc = AutoImageProcessor.from_pretrained("facebook/dinov2-small")
    dino = AutoModel.from_pretrained("facebook/dinov2-small").eval()
    out = dino(**proc(images=img, return_tensors="pt"))
    got["eyeA"] = out.last_hidden_state[:, 0].shape[-1]
    print(f"eyeA  dinov2-small   dim {got['eyeA']}  ({time.time() - t:.1f}s)")

    t = time.time()
    import timm

    rn = timm.create_model("resnet50", pretrained=True, num_classes=0).eval()
    cfg = timm.data.resolve_data_config({}, model=rn)
    tf = timm.data.create_transform(**cfg)
    got["eyeB"] = rn(tf(img).unsqueeze(0)).shape[-1]
    print(f"eyeB  timm resnet50  dim {got['eyeB']}  ({time.time() - t:.1f}s)  weights: {rn.pretrained_cfg.get('hf_hub_id') or rn.pretrained_cfg.get('tag')}")

    from sentence_transformers import SentenceTransformer

    for key, name in (("poetA", "sentence-transformers/all-mpnet-base-v2"), ("poetB", "sentence-transformers/all-MiniLM-L6-v2")):
        t = time.time()
        m = SentenceTransformer(name, device="cpu")
        got[key] = m.encode(["a calm, still, empty beach at dawn"]).shape[-1]
        print(f"{key} {name.split('/')[-1]:<20} dim {got[key]}  ({time.time() - t:.1f}s)")

    bad = {k: (got[k], v) for k, v in EXPECTED.items() if got[k] != v}
    if bad:
        raise SystemExit(f"DIMENSION MISMATCH (got, expected): {bad}")
    print("all four models cached and producing the expected dimensions")


if __name__ == "__main__":
    main()
