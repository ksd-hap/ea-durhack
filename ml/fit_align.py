"""Fit each agent's map into the common frame (Poet-A's whitened PCA space), on calibration only.

For every agent a (x = raw embedding, a row vector):
    mu_a, W_a : PCA to k=32 with whitening folded in   z = (x - mu_a) @ W_a
    R_a       : orthogonal Procrustes from z_a to z_poetA on the SAME calibration scenes
                M = Z_a.T @ Z_poetA;  U, S, Vt = svd(M);  R = U @ Vt   (identity for Poet-A)
    B_a       : ridge regression comparison (alpha fixed), a linear map, not a rotation
    R_random_a: QR of a seeded Gaussian, the control (shared frame deliberately wrong)
Anchors: phrases encoded by Poet-A's own model, mapped by Poet-A's mu/W, unit length.
Score statistics per agent AND per method (fitted / ridge / random) from calibration, so the
random-rotation control is standardised with its own statistics (Role 1 review finding).
Thresholds: tertiles of Poet-A's standardised calibration scores.
Truth: Poet-A's frame applied to the mean of all 5 caption embeddings, standardised with its
own calibration statistics, thresholded with the same tertiles.

    python -m ml.fit_align [--k 32] [--ridge-alpha 10]
"""

import argparse
import json

import numpy as np

from ml.common import AGENTS, ANCHOR_PHRASES, CACHE, K, MODELS, SEED, load_manifest, unit_rows


def pca_whiten(X, k):
    mu = X.mean(0)
    _, S, Vt = np.linalg.svd(X - mu, full_matrices=False)
    eig = S**2 / (len(X) - 1)
    W = Vt[:k].T / np.sqrt(eig[:k])
    return mu, W


def procrustes(X, Y):
    U, _, Vt = np.linalg.svd(X.T @ Y)
    return U @ Vt


def ridge(X, Y, alpha):
    return np.linalg.solve(X.T @ X + alpha * np.eye(X.shape[1]), X.T @ Y)


def random_orthogonal(k, seed):
    Q, R = np.linalg.qr(np.random.default_rng(seed).standard_normal((k, k)))
    return Q * np.sign(np.diag(R))


def raw_scores(Z, anchors):
    U = unit_rows(Z)
    v = (U @ anchors["valence_pos"].T).mean(1) - (U @ anchors["valence_neg"].T).mean(1)
    a = (U @ anchors["arousal_pos"].T).mean(1) - (U @ anchors["arousal_neg"].T).mean(1)
    return v, a


def stats(Z, anchors):
    v, a = raw_scores(Z, anchors)
    return {"val_mean": float(v.mean()), "val_std": float(v.std()), "aro_mean": float(a.mean()), "aro_std": float(a.std())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=K)
    ap.add_argument("--ridge-alpha", type=float, default=10.0)
    a = ap.parse_args()
    rows = load_manifest()
    cal = np.array([r["split"] == "calibration" for r in rows])
    X = {ag: np.load(CACHE / f"{ag}.npy").astype(np.float64) for ag in AGENTS}

    fit = {}
    for ag in AGENTS:
        mu, W = pca_whiten(X[ag][cal], a.k)
        fit[ag] = {"mu": mu, "W": W}
    Y = (X["poetA"][cal] - fit["poetA"]["mu"]) @ fit["poetA"]["W"]
    for i, ag in enumerate(AGENTS):
        Z = (X[ag][cal] - fit[ag]["mu"]) @ fit[ag]["W"]
        fit[ag]["R"] = np.eye(a.k) if ag == "poetA" else procrustes(Z, Y)
        fit[ag]["B"] = np.eye(a.k) if ag == "poetA" else ridge(Z, Y, a.ridge_alpha)
        fit[ag]["R_random"] = random_orthogonal(a.k, SEED + 1000 + i)

    from sentence_transformers import SentenceTransformer

    mpnet = SentenceTransformer(MODELS["poetA"], device="cpu")
    anchors = {
        pole: unit_rows((mpnet.encode(phr).astype(np.float64) - fit["poetA"]["mu"]) @ fit["poetA"]["W"])
        for pole, phr in ANCHOR_PHRASES.items()
    }

    for ag in AGENTS:
        Z = (X[ag][cal] - fit[ag]["mu"]) @ fit[ag]["W"]
        fit[ag]["stats"] = {
            "fitted": stats(Z @ fit[ag]["R"], anchors),
            "ridge": stats(Z @ fit[ag]["B"], anchors),
            "random": stats(Z @ fit[ag]["R_random"], anchors),
        }

    s = fit["poetA"]["stats"]["fitted"]
    v, ar = raw_scores(Y, anchors)
    thresholds = {
        "valence": [float(x) for x in np.quantile((v - s["val_mean"]) / s["val_std"], [1 / 3, 2 / 3])],
        "arousal": [float(x) for x in np.quantile((ar - s["aro_mean"]) / s["aro_std"], [1 / 3, 2 / 3])],
        "hysteresis": 0.1,
    }
    T = (np.load(CACHE / "truth.npy").astype(np.float64)[cal] - fit["poetA"]["mu"]) @ fit["poetA"]["W"]
    truth_stats = stats(T, anchors)

    arrays = {f"{ag}_{key}": fit[ag][key] for ag in AGENTS for key in ("mu", "W", "R", "B", "R_random")}
    arrays.update({f"anchor_{p}": m for p, m in anchors.items()})
    np.savez(CACHE / "fit.npz", **arrays)
    meta = {
        "k": a.k, "ridge_alpha": a.ridge_alpha, "seed": SEED, "thresholds": thresholds,
        "truth_stats": truth_stats, "stats": {ag: fit[ag]["stats"] for ag in AGENTS},
        "dims": {ag: int(X[ag].shape[1]) for ag in AGENTS}, "n_calibration": int(cal.sum()),
    }
    (CACHE / "fit.json").write_text(json.dumps(meta, indent=2))

    # Sanity: Procrustes on calibration should bring each agent close to Poet-A.
    for ag in AGENTS:
        Z = (X[ag][cal] - fit[ag]["mu"]) @ fit[ag]["W"]
        cos = (unit_rows(Z @ fit[ag]["R"]) * unit_rows(Y)).sum(1).mean()
        cos_r = (unit_rows(Z @ fit[ag]["R_random"]) * unit_rows(Y)).sum(1).mean()
        print(f"{ag:6s} calibration mean cos to Poet-A: fitted {cos:.3f}, random {cos_r:.3f}")
    print(f"thresholds {thresholds}")


if __name__ == "__main__":
    main()
