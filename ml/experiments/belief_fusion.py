"""Experiment: does sharing BELIEFS (mood scores in the common frame) help, and how does it
degrade when the network is cut?  (Role 1 / Role 2, exploratory; not yet in the live agents.)

Each agent i has standardised scores s_i = (valence, arousal) for a scene, in the common frame.
Belief sharing: agent i fuses its own scores with the peers' scores it RECEIVED this scene
(each peer's message arrives with probability 1 - loss):
    f_i = mean of s_j over {i} + received peers
then rescales by the std of that subset's mean on CALIBRATION scenes (averaging shrinks the
spread; without this, every fused reading drifts toward the middle tertile), and quantises with
the usual thresholds. Every agent decides for itself; nobody is in charge.

Reported on the 200 held-out scenes, Monte-Carlo over 200 draws of the message drops:
  * accuracy vs caption truth (mode+density, and mode) averaged over agents, and EYES ONLY
  * pairwise agreement (exact context)
Configurations:
  all4         every agent shares with every agent              (the proposal)
  eyes-only    only Eye-A and Eye-B share with each other       (circularity check: truth comes
                                                                  from captions, so poets' scores
                                                                  could inflate accuracy)
  random       all4, but in the RANDOM-rotation frame           (control: does the shared frame
                                                                  matter, or does averaging alone help?)

    python -m ml.experiments.belief_fusion [--truth=c345]
"""

import itertools
import json

import numpy as np

from ml.common import AGENTS, ARTIFACTS, CACHE, level, load_manifest
from ml.fit_align import raw_scores

LOSSES = [0.0, 0.25, 0.5, 0.75, 1.0]
DRAWS = 200


def holdout_truth(rows):
    """Truth from captions 3-5 only: captions 1 and 2 are the poets' own views, so excluding them
    removes the circularity. Cached in CACHE/truth_c345.npy (MPNet, mean of the 3 embeddings)."""
    path = CACHE / "truth_c345.npy"
    if not path.exists():
        from sentence_transformers import SentenceTransformer

        mpnet = SentenceTransformer("sentence-transformers/all-mpnet-base-v2", device="cpu")
        e = mpnet.encode([c for r in rows for c in r["captions"][2:5]], batch_size=64)
        np.save(path, e.reshape(len(rows), 3, -1).mean(1).astype(np.float32))
    return np.load(path).astype(np.float64)


def load(truth_kind="all5"):
    rows = load_manifest()
    split = np.array([r["split"] for r in rows])
    f = np.load(CACHE / "fit.npz")
    meta = json.loads((CACHE / "fit.json").read_text())
    anchors = {p: f[f"anchor_{p}"] for p in ("valence_pos", "valence_neg", "arousal_pos", "arousal_neg")}
    X = {ag: np.load(CACHE / f"{ag}.npy").astype(np.float64) for ag in AGENTS}
    raw = np.load(CACHE / "truth.npy").astype(np.float64) if truth_kind == "all5" else holdout_truth(rows)
    T = (raw - f["poetA_mu"]) @ f["poetA_W"]
    return split, f, meta, anchors, X, T


def std_scores(f, meta, anchors, X, method):
    """(n, 4 agents, 2) standardised (valence, arousal) for every row, per method."""
    key = {"fitted": "R", "random": "R_random"}[method]
    out = []
    for ag in AGENTS:
        Z = ((X[ag] - f[f"{ag}_mu"]) @ f[f"{ag}_W"]) @ f[f"{ag}_{key}"]
        v, a = raw_scores(Z, anchors)
        st = meta["stats"][ag][method]
        out.append(np.stack([(v - st["val_mean"]) / st["val_std"], (a - st["aro_mean"]) / st["aro_std"]], -1))
    return np.stack(out, 1)


def run(S, cal, ev, truth, th, members, loss, rng):
    """Accuracy/agreement over held-out scenes for agents `members` sharing with each other."""
    m = len(members)
    # Calibration std of the mean over every subset that contains a given agent (rescaling).
    scale = {}
    for k in range(1, m + 1):
        for sub in itertools.combinations(range(m), k):
            scale[sub] = S[cal][:, [members[j] for j in sub]].mean(1).std(0)  # (2,)
    Se = S[ev][:, members]  # (n, m, 2)
    n = Se.shape[0]
    tv, ta = truth
    acc, mode_acc, agree = [], [], []
    for _ in range(DRAWS if 0 < loss < 1 else 1):
        recv = rng.random((n, m, m)) >= loss  # recv[s, i, j]: i heard j this scene
        ctx_v = np.empty((n, m), int)
        ctx_a = np.empty((n, m), int)
        for i in range(m):
            for s in range(n):
                sub = tuple(j for j in range(m) if j == i or recv[s, i, j])
                fused = Se[s, list(sub)].mean(0) / scale[sub]
                ctx_v[s, i] = level(fused[0], *th["valence"])
                ctx_a[s, i] = level(fused[1], *th["arousal"])
        hit = (ctx_v == tv[:, None]) & (ctx_a == ta[:, None])
        acc.append(hit.mean())
        mode_acc.append((ctx_v == tv[:, None]).mean())
        pairs = [(i, j) for i in range(m) for j in range(i + 1, m)]
        agree.append(np.mean([((ctx_v[:, i] == ctx_v[:, j]) & (ctx_a[:, i] == ctx_a[:, j])).mean() for i, j in pairs]))
    return {"accuracy": float(np.mean(acc)), "mode_accuracy": float(np.mean(mode_acc)), "agreement": float(np.mean(agree))}


def main():
    import sys

    truth_kind = "c345" if "--truth=c345" in sys.argv else "all5"
    split, f, meta, anchors, X, T = load(truth_kind)
    cal, ev = split == "calibration", split == "evaluation"
    th = meta["thresholds"]
    if truth_kind == "all5":
        ts = meta["truth_stats"]
    else:  # standardise the held-out-caption truth with ITS OWN calibration statistics
        cv, ca = raw_scores(T[cal], anchors)
        ts = {"val_mean": cv.mean(), "val_std": cv.std(), "aro_mean": ca.mean(), "aro_std": ca.std()}
    print(f"TRUTH = {'mean of all 5 captions (includes the poets captions 1-2)' if truth_kind == 'all5' else 'captions 3-5 only (no agent ever sees them)'}")
    tvr, tar = raw_scores(T[ev], anchors)
    truth = (level((tvr - ts["val_mean"]) / ts["val_std"], *th["valence"]), level((tar - ts["aro_mean"]) / ts["aro_std"], *th["arousal"]))
    rng = np.random.default_rng(0)
    S = {m: std_scores(f, meta, anchors, X, m) for m in ("fitted", "random")}
    ALL, EYES = [0, 1, 2, 3], [0, 2]  # AGENTS = eyeA, poetA, eyeB, poetB

    res = {}
    for name, method, members in (("all4", "fitted", ALL), ("eyes-only", "fitted", EYES), ("random", "random", ALL)):
        res[name] = {str(p): run(S[method], cal, ev, truth, th, members, p, rng) for p in LOSSES}
    # Eye accuracy inside the all-4 fusion (the clean number: do the EYES get more accurate?).
    res["all4_eyes"] = {}
    for p in LOSSES:
        r = run_eyes_in_all4(S["fitted"], cal, ev, truth, th, p, rng)
        res["all4_eyes"][str(p)] = r

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / f"belief_fusion_{truth_kind}.json").write_text(json.dumps(res, indent=2))
    pct = lambda x: f"{100 * x:5.1f}%"
    print("loss = probability each peer's belief is lost (1.0 = cut: every agent alone)\n")
    print(f"{'config':<34}" + "".join(f"{'loss ' + str(p):>12}" for p in LOSSES))
    for name, label in (("all4", "all 4 share: accuracy"), ("all4", "all 4 share: agreement"),
                        ("all4_eyes", "all 4 share: EYES' accuracy"),
                        ("eyes-only", "eyes-only share: eyes' accuracy"), ("eyes-only", "eyes-only share: agreement"),
                        ("random", "RANDOM frame share: accuracy"), ("random", "RANDOM frame share: agreement")):
        key = "agreement" if "agreement" in label else "accuracy"
        print(f"{label:<34}" + "".join(f"{pct(res[name][str(p)][key]):>12}" for p in LOSSES))
    print("\n(mode accuracy, all 4 share):" + "".join(f"{pct(res['all4'][str(p)]['mode_accuracy']):>10}" for p in LOSSES))


def run_eyes_in_all4(S, cal, ev, truth, th, loss, rng):
    """All four share, but report accuracy of the two eye agents only."""
    members = [0, 1, 2, 3]
    m = 4
    scale = {}
    for k in range(1, m + 1):
        for sub in itertools.combinations(range(m), k):
            scale[sub] = S[cal][:, list(sub)].mean(1).std(0)
    Se = S[ev]
    n = Se.shape[0]
    tv, ta = truth
    acc = []
    for _ in range(DRAWS if 0 < loss < 1 else 1):
        recv = rng.random((n, m, m)) >= loss
        hits = []
        for i in (0, 2):
            for s in range(n):
                sub = tuple(j for j in range(m) if j == i or recv[s, i, j])
                fused = Se[s, list(sub)].mean(0) / scale[sub]
                hits.append(level(fused[0], *th["valence"]) == tv[s] and level(fused[1], *th["arousal"]) == ta[s])
        acc.append(np.mean(hits))
    return {"accuracy": float(np.mean(acc))}


if __name__ == "__main__":
    main()
