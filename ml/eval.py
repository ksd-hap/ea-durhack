"""Held-out evaluation (200 scenes) and the G1 decision. Every reported number comes from here.

Per agent and per method (fitted Procrustes / ridge / R_random control):
  * (mode, density) accuracy against caption-based truth; mode alone; 95% Wilson interval
  * image-to-caption retrieval in the common frame (Eye -> Poet-A), R@1 and R@5
  * agreement among the four agents (exact context, and mode only)
G1 passes if, for both eyes, fitted mode accuracy's Wilson lower bound beats both 1/3 chance
and the majority-mode baseline, AND a paired bootstrap of (fitted - random) is positive at 95%.

Writes ml/results.md, ml/artifacts/metrics.json and ml/artifacts/alignment.png.

    python -m ml.eval
"""

import json

import numpy as np

from ml.common import AGENTS, ARTIFACTS, CACHE, MODES, ROOT, load_manifest, level, unit_rows
from ml.fit_align import raw_scores

METHODS = {"fitted": "R", "ridge": "B", "random": "R_random"}
EYES = ["eyeA", "eyeB"]


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (float(c - h), float(c + h))


def load_fit():
    f = np.load(CACHE / "fit.npz")
    meta = json.loads((CACHE / "fit.json").read_text())
    anchors = {p: f[f"anchor_{p}"] for p in ("valence_pos", "valence_neg", "arousal_pos", "arousal_neg")}
    return f, meta, anchors


def contexts(Z, st, th):
    v, a = raw_scores(Z, ANCH)
    vl = level((v - st["val_mean"]) / st["val_std"], *th["valence"])
    al = level((a - st["aro_mean"]) / st["aro_std"], *th["arousal"])
    return vl, al


def truth_levels(T, meta):
    return contexts(T, meta["truth_stats"], meta["thresholds"])


ANCH = None


def main():
    global ANCH
    rows = load_manifest()
    ev = np.array([r["split"] == "evaluation" for r in rows])
    n = int(ev.sum())
    f, meta, ANCH = load_fit()
    th = meta["thresholds"]
    X = {ag: np.load(CACHE / f"{ag}.npy").astype(np.float64)[ev] for ag in AGENTS}
    T = (np.load(CACHE / "truth.npy").astype(np.float64)[ev] - f["poetA_mu"]) @ f["poetA_W"]
    tv, ta = truth_levels(T, meta)
    mode_counts = np.bincount(tv, minlength=3)
    majority = float(mode_counts.max() / n)

    Z = {ag: (X[ag] - f[f"{ag}_mu"]) @ f[f"{ag}_W"] for ag in AGENTS}
    common = {m: {ag: Z[ag] @ f[f"{ag}_{key}"] for ag in AGENTS} for m, key in METHODS.items()}
    rng = np.random.default_rng(0)
    boot = rng.integers(0, n, size=(2000, n))

    res = {"n_eval": n, "chance_mode": 1 / 3, "chance_context": 1 / 9, "majority_mode": majority,
           "truth_mode_counts": dict(zip(MODES, map(int, mode_counts))), "agents": {}, "agreement": {}}
    hits = {}
    for m in METHODS:
        for ag in AGENTS:
            vl, al = contexts(common[m][ag], meta["stats"][ag][m], th)
            mode_hit = vl == tv
            ctx_hit = mode_hit & (al == ta)
            hits[(m, ag)] = (vl, al, mode_hit)
            entry = {
                "mode_acc": float(mode_hit.mean()), "mode_ci95": wilson(int(mode_hit.sum()), n),
                "density_acc": float((al == ta).mean()), "context_acc": float(ctx_hit.mean()),
                "context_ci95": wilson(int(ctx_hit.sum()), n),
            }
            if ag != "poetA":
                S = unit_rows(common[m][ag]) @ unit_rows(common[m]["poetA"]).T
                rank = (S > S[np.arange(n), np.arange(n)][:, None]).sum(1)
                entry.update(r_at_1=float((rank < 1).mean()), r_at_5=float((rank < 5).mean()))
            res["agents"].setdefault(ag, {})[m] = entry
        pairs = [(a, b) for i, a in enumerate(AGENTS) for b in AGENTS[i + 1 :]]
        exact = [np.mean((hits[(m, a)][0] == hits[(m, b)][0]) & (hits[(m, a)][1] == hits[(m, b)][1])) for a, b in pairs]
        mode_only = [np.mean(hits[(m, a)][0] == hits[(m, b)][0]) for a, b in pairs]
        all4 = np.all([(hits[(m, ag)][0] == hits[(m, "eyeA")][0]) & (hits[(m, ag)][1] == hits[(m, "eyeA")][1]) for ag in AGENTS], 0)
        all4_mode = np.all([hits[(m, ag)][0] == hits[(m, "eyeA")][0] for ag in AGENTS], 0)
        res["agreement"][m] = {"pairwise_context": float(np.mean(exact)), "pairwise_mode": float(np.mean(mode_only)),
                               "all_four_context": float(all4.mean()), "all_four_mode": float(all4_mode.mean())}

    g1 = {}
    for ag in EYES:
        fit_hit = hits[("fitted", ag)][2].astype(float)
        rnd_hit = hits[("random", ag)][2].astype(float)
        diff = (fit_hit[boot] - rnd_hit[boot]).mean(1)
        lo = res["agents"][ag]["fitted"]["mode_ci95"][0]
        g1[ag] = {"wilson_lower": lo, "beats_chance_and_majority": lo > max(1 / 3, majority),
                  "boot_diff_vs_random_ci95": [float(np.quantile(diff, 0.025)), float(np.quantile(diff, 0.975))]}
        g1[ag]["beats_random"] = g1[ag]["boot_diff_vs_random_ci95"][0] > 0
    res["g1"] = {"per_eye": g1, "pass": all(g["beats_chance_and_majority"] and g["beats_random"] for g in g1.values()),
                 "method": "procrustes", "k": meta["k"]}

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "metrics.json").write_text(json.dumps(res, indent=2))
    write_report(res, meta)
    plot(res)
    print((ROOT / "ml" / "results.md").read_text(encoding="utf-8"))


def pct(x):
    return f"{100 * x:.1f}%"


def write_report(res, meta):
    A = res["agents"]
    L = ["# Role 1 results: held-out evaluation", "",
         f"{res['n_eval']} held-out COCO val2017 scenes (disjoint from the 600 calibration scenes, seed 0). "
         f"k = {meta['k']}, ridge alpha = {meta['ridge_alpha']}. Truth = Poet-A's frame applied to the mean of all 5 caption embeddings.", "",
         f"**G1: {'PASS' if res['g1']['pass'] else 'FAIL'}** (Procrustes). Chance: mode 33.3%, (mode, density) 11.1%; "
         f"majority-mode baseline {pct(res['majority_mode'])}. Retrieval chance R@1 0.5%, R@5 2.5%.", "",
         "## Mode accuracy and (mode, density) accuracy", "",
         "| agent | method | mode acc [95% CI] | context acc | density acc | R@1 | R@5 |", "|---|---|---|---|---|---|---|"]
    for ag in AGENTS:
        for m in METHODS:
            e = A[ag][m]
            ci = f"[{pct(e['mode_ci95'][0])}, {pct(e['mode_ci95'][1])}]"
            r1 = pct(e["r_at_1"]) if "r_at_1" in e else "n/a"
            r5 = pct(e["r_at_5"]) if "r_at_5" in e else "n/a"
            L.append(f"| {ag} | {m} | {pct(e['mode_acc'])} {ci} | {pct(e['context_acc'])} | {pct(e['density_acc'])} | {r1} | {r5} |")
    L += ["", "Poet-A defines the frame (R = I), so its three rows differ only in the random control. Retrieval is Eye/Poet-B -> Poet-A in the common frame.", "",
          "## Agreement among the four agents", "", "| method | pairwise context | pairwise mode | all four context | all four mode |", "|---|---|---|---|---|"]
    for m, g in res["agreement"].items():
        L.append(f"| {m} | {pct(g['pairwise_context'])} | {pct(g['pairwise_mode'])} | {pct(g['all_four_context'])} | {pct(g['all_four_mode'])} |")
    L += ["", "## G1 decision", ""]
    for ag, g in res["g1"]["per_eye"].items():
        L.append(f"- {ag}: fitted mode-accuracy Wilson lower bound {pct(g['wilson_lower'])} "
                 f"(needs > {pct(max(1 / 3, res['majority_mode']))}); paired bootstrap fitted - random 95% CI "
                 f"[{pct(g['boot_diff_vs_random_ci95'][0])}, {pct(g['boot_diff_vs_random_ci95'][1])}].")
    L += ["", "## Honest limits", "",
          "- Truth is a caption-based proxy (MPNet on all 5 captions), not human mood labels. The poets' own captions are among those 5, so their accuracy is partly circular; the eyes are the clean test.",
          "- Perception is precomputed offline per agent; alignment and every decision happen live in the browser.",
          "- Demo scenes were chosen by caption-based truth only, from a keyword pool disjoint from these 200."]
    (ROOT / "ml" / "results.md").write_text("\n".join(L) + "\n", encoding="utf-8")


def plot(res):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # dataviz reference palette, categorical slots 1-3 (validated together; aqua < 3:1 on the
    # light surface, so every bar carries a visible value label: the relief rule).
    colors = {"fitted": "#2a78d6", "ridge": "#eb6834", "random": "#1baf7a"}
    labels = {"fitted": "Procrustes (fitted)", "ridge": "Ridge (comparison)", "random": "Random rotation (control)"}
    agents = ["eyeA", "eyeB", "poetB"]
    names = {"eyeA": "Eye-A\nDINOv2 · full image", "eyeB": "Eye-B\nResNet-50 · 70% crop", "poetB": "Poet-B\nMiniLM · caption 2"}
    fig, ax = plt.subplots(figsize=(9, 4.8), dpi=200)
    fig.patch.set_facecolor("#fcfcfb")
    ax.set_facecolor("#fcfcfb")
    w = 0.26
    for j, m in enumerate(METHODS):
        xs = np.arange(len(agents)) + (j - 1) * w
        vals = [100 * res["agents"][ag][m]["mode_acc"] for ag in agents]
        ax.bar(xs, vals, w - 0.02, color=colors[m], label=labels[m], zorder=2)
        for x, v in zip(xs, vals):
            ax.text(x, v + 1, f"{v:.0f}%", ha="center", va="bottom", fontsize=9, color="#0b0b0b")
    ax.axhline(100 / 3, color="#52514e", lw=1, ls=(0, (4, 3)), zorder=1)
    ax.set_xlim(-0.75, len(agents) - 0.45)
    ax.text(-0.72, 100 / 3 + 1, "chance 33%", color="#52514e", fontsize=8.5, ha="left")
    ax.set_xticks(np.arange(len(agents)), [names[a] for a in agents], fontsize=9, color="#0b0b0b")
    ax.set_ylabel("Mode accuracy vs caption truth (%)", color="#52514e", fontsize=9)
    ax.set_ylim(0, max(75, ax.get_ylim()[1]))
    ax.tick_params(axis="y", colors="#52514e", labelsize=8.5)
    ax.grid(axis="y", color="#e6e5e0", lw=0.8, zorder=0)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color("#c9c8c2")
    ax.set_title(f"Separately trained encoders share a frame: held-out mode accuracy (n = {res['n_eval']})",
                 loc="left", fontsize=11, color="#0b0b0b")
    ax.legend(frameon=False, fontsize=8.5, loc="upper right", ncol=3, bbox_to_anchor=(1, 1.0))
    fig.tight_layout()
    fig.savefig(ARTIFACTS / "alignment.png", facecolor=fig.get_facecolor())


if __name__ == "__main__":
    main()
