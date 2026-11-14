"""Generate FAKE data shaped exactly like the shared contract, so nobody waits for Role 1.

Writes:
  web/data/agents.json        per-agent mu, W, R, R_random, score stats; anchors; thresholds
  web/data/scenes.json        48 demo scenes (per-agent views + truth)
  web/data/testvectors.json   3 scenes per agent with expected z / valence / arousal / context
  sim/data/scenes_eval.json   200 held-out scenes for the simulator

Every file carries "fake": true (agents.json) or ids starting "fake" so nobody mistakes it
for real results. Role 1's ml/export.py overwrites all four with real data.

Fake world: each scene has a latent s in R^32 (the "true" common frame). Agent a sees
x = mu_a + (s @ Rtrue_a.T) @ Q_a.T + noise_a, where Q_a has orthonormal columns. So with
W = Q_a and R = Rtrue_a, ((x - mu) @ W) @ R recovers s plus noise. That makes alignment
work (and the random-rotation control fail) for the right reasons.

Expected values in testvectors.json are computed from the ROUNDED params that the JS will
read, so the JS-vs-NumPy check isolates arithmetic bugs from rounding. Role 1: do the same.

Usage (from repo root):  py tools/make_fake_data.py      (or python3)
"""

import json
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
K = 32
DIMS = {"eyeA": 384, "poetA": 768, "eyeB": 2048, "poetB": 384}
NOISE = {"eyeA": 0.45, "poetA": 0.30, "eyeB": 0.60, "poetB": 0.50}
N_CAL, N_EVAL, N_DEMO = 400, 200, 48
DEC = 5
MODES = ["aeolian", "dorian", "ionian"]

rng = np.random.default_rng(0)


def orthonormal(n, k, g):
    q, _ = np.linalg.qr(g.standard_normal((n, k)))
    return q


def unit_rows(m):
    return m / np.linalg.norm(m, axis=1, keepdims=True)


def r5(a):
    return np.round(np.asarray(a, dtype=np.float64), DEC)


# Mood directions in the common frame and anchor phrases around them.
e_v = rng.standard_normal(K)
e_v /= np.linalg.norm(e_v)
e_a = rng.standard_normal(K)
e_a -= e_a.dot(e_v) * e_v
e_a /= np.linalg.norm(e_a)
anchors = {
    "valence_pos": unit_rows(e_v + 0.6 * rng.standard_normal((6, K)) / np.sqrt(K)),
    "valence_neg": unit_rows(-e_v + 0.6 * rng.standard_normal((6, K)) / np.sqrt(K)),
    "arousal_pos": unit_rows(e_a + 0.6 * rng.standard_normal((6, K)) / np.sqrt(K)),
    "arousal_neg": unit_rows(-e_a + 0.6 * rng.standard_normal((6, K)) / np.sqrt(K)),
}
anchors = {k: r5(v) for k, v in anchors.items()}

# Agent geometry.
geo = {}
for a, dim in DIMS.items():
    Q = orthonormal(dim, K, rng)
    Rtrue = np.eye(K) if a == "poetA" else orthonormal(K, K, rng)
    Rrand = orthonormal(K, K, np.random.default_rng(1000 + dim))
    mu = 0.1 * rng.standard_normal(dim)
    geo[a] = {"Q": Q, "Rtrue": Rtrue, "Rrand": Rrand, "mu": mu}


def latent(n):
    return rng.standard_normal((n, K))


def view(a, S):
    g = geo[a]
    clean = (S @ g["Rtrue"].T) @ g["Q"].T
    return g["mu"] + clean + NOISE[a] * rng.standard_normal(clean.shape)


def raw_scores(Z):
    U = Z / np.linalg.norm(Z, axis=1, keepdims=True)
    v = (U @ anchors["valence_pos"].T).mean(1) - (U @ anchors["valence_neg"].T).mean(1)
    ar = (U @ anchors["arousal_pos"].T).mean(1) - (U @ anchors["arousal_neg"].T).mean(1)
    return v, ar


def level(s, lo, hi):
    return np.where(s < lo, 0, np.where(s < hi, 1, 2))


# Calibration: fit per-agent score statistics; thresholds from Poet-A's tertiles.
S_cal = latent(N_CAL)
params = {}
for a in DIMS:
    g = geo[a]
    p = {"mu": r5(g["mu"]), "W": r5(g["Q"]), "R": r5(g["Rtrue"]), "R_random": r5(g["Rrand"])}
    Z = ((view(a, S_cal) - p["mu"]) @ p["W"]) @ p["R"]
    v, ar = raw_scores(Z)
    p.update(
        val_mean=round(float(v.mean()), DEC), val_std=round(float(v.std()), DEC),
        aro_mean=round(float(ar.mean()), DEC), aro_std=round(float(ar.std()), DEC),
    )
    params[a] = p
    if a == "poetA":
        vs = (v - p["val_mean"]) / p["val_std"]
        as_ = (ar - p["aro_mean"]) / p["aro_std"]
        thresholds = {
            "valence": [round(float(x), DEC) for x in np.quantile(vs, [1 / 3, 2 / 3])],
            "arousal": [round(float(x), DEC) for x in np.quantile(as_, [1 / 3, 2 / 3])],
            "hysteresis": 0.1,
        }

# Truth comes from the clean latent scored like Poet-A (stands in for "mpnet on all 5 captions").
truth_stats = raw_scores(S_cal)
tv_mean, tv_std = truth_stats[0].mean(), truth_stats[0].std()
ta_mean, ta_std = truth_stats[1].mean(), truth_stats[1].std()


def truth_of(S):
    v, ar = raw_scores(S)
    vl = level((v - tv_mean) / tv_std, *thresholds["valence"])
    al = level((ar - ta_mean) / ta_std, *thresholds["arousal"])
    return [{"mode": MODES[i], "density": int(j) + 1} for i, j in zip(vl, al)]


def make_scenes(n, prefix):
    S = latent(n)
    views = {a: r5(view(a, S)) for a in DIMS}
    truths = truth_of(S)
    return [
        {
            "id": f"{prefix}{i:03d}",
            "truth": truths[i],
            "views": {a: views[a][i].tolist() for a in DIMS},
            "thumb": None,
            "caption": f"fake scene {prefix}{i:03d}",
        }
        for i in range(n)
    ]


demo = make_scenes(N_DEMO, "fakedemo")
evals = make_scenes(N_EVAL, "fakeeval")

# Test vectors computed from the rounded params + rounded views, exactly what JS reads.
tests = []
for a in DIMS:
    p = params[a]
    for sc in evals[:3]:
        x = np.array(sc["views"][a])
        z = ((x - p["mu"]) @ p["W"]) @ p["R"]
        v, ar = raw_scores(z[None, :])
        vs = (v[0] - p["val_mean"]) / p["val_std"]
        as_ = (ar[0] - p["aro_mean"]) / p["aro_std"]
        vl = int(level(np.array([vs]), *thresholds["valence"])[0])
        al = int(level(np.array([as_]), *thresholds["arousal"])[0])
        tests.append({
            "agent": a, "scene": sc["id"], "x": sc["views"][a], "z": z.tolist(),
            "valence_raw": float(v[0]), "arousal_raw": float(ar[0]),
            "valence": float(vs), "arousal": float(as_),
            "context": {"mode": MODES[vl], "density": al + 1},
        })

agents_json = {
    "fake": True,
    "k": K,
    "anchors": {k: v.tolist() for k, v in anchors.items()},
    "agents": {
        a: {
            "dim": DIMS[a],
            "mu": p["mu"].tolist(), "W": p["W"].tolist(), "R": p["R"].tolist(),
            "R_random": p["R_random"].tolist(),
            "val_mean": p["val_mean"], "val_std": p["val_std"],
            "aro_mean": p["aro_mean"], "aro_std": p["aro_std"],
        }
        for a, p in params.items()
    },
    "thresholds": thresholds,
}


def write(rel, obj):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(f"wrote {rel} ({os.path.getsize(path) / 1e6:.1f} MB)")


write("web/data/agents.json", agents_json)
write("web/data/scenes.json", demo)
write("web/data/testvectors.json", tests)
write("sim/data/scenes_eval.json", evals)
cells = {(t["truth"]["mode"], t["truth"]["density"]) for t in demo}
print(f"demo covers {len(cells)}/9 (mode, density) cells; thresholds {thresholds}")
