"""Slide charts from the simulator (Role 1): resilience to message loss, and Melkor detection.

Reads sim/out/results.csv (node sim/sim.mjs; 10 seeds x method x loss x rogue over the 200
held-out scenes) and writes:
  ml/artifacts/resilience.png   accuracy vs truth against message loss, 4 methods (rogue off)
  ml/artifacts/detection.png    bars until every honest agent flags Melkor, against loss (EA)

    python -m ml.plot_resilience
"""

import csv
from collections import defaultdict

import numpy as np

from ml.common import ARTIFACTS, ROOT

SURFACE, INK, INK2, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e0", "#c9c8c2"
# dataviz reference palette, categorical slots 1-4 (validated together; aqua and yellow are below
# 3:1 on this surface, so every line is direct-labelled and also has its own marker shape).
SERIES = [
    ("ea", "EÄ: shared frame + belief sharing", "#2a78d6", "o"),
    ("independent", "EÄ agents alone (no sharing)", "#eb6834", "s"),
    ("baseline", "Conductor baseline (one leader)", "#1baf7a", "^"),
    ("random", "Random rotation (control)", "#eda100", "D"),
]


def load():
    rows = list(csv.DictReader(open(ROOT / "sim/out/results.csv", encoding="utf-8")))
    acc = defaultdict(list)
    det = defaultdict(list)
    for r in rows:
        key = (r["method"], float(r["loss"]), int(r["rogue"]))
        acc[key].append(float(r["accuracy"]))
        if r["detect_all_bars"] != "":
            det[key].append(float(r["detect_all_bars"]))
        else:
            det[key].append(np.nan)
    return acc, det, len({r["seed"] for r in rows})


def style(ax):
    ax.set_facecolor(SURFACE)
    ax.grid(axis="y", color=GRID, lw=0.8, zorder=0)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(AXIS)
    ax.tick_params(colors=INK2, labelsize=9)


def main():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    acc, det, seeds = load()
    losses = sorted({k[1] for k in acc})
    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    # 1. Resilience.
    fig, ax = plt.subplots(figsize=(9.5, 5.2), dpi=200)
    fig.patch.set_facecolor(SURFACE)
    style(ax)
    ends = []
    for method, label, color, marker in SERIES:
        ys = np.array([100 * np.mean(acc[(method, p, 0)]) for p in losses])
        lo = np.array([100 * np.min(acc[(method, p, 0)]) for p in losses])
        hi = np.array([100 * np.max(acc[(method, p, 0)]) for p in losses])
        ax.fill_between([100 * p for p in losses], lo, hi, color=color, alpha=0.12, lw=0, zorder=1)
        ax.plot([100 * p for p in losses], ys, color=color, lw=2, marker=marker, ms=8,
                markeredgecolor=SURFACE, markeredgewidth=2, zorder=3, label=label)
        ends.append([ys[-1], label, color, ys])
    # Direct labels. EÄ is labelled along its own line (at the cut it lands exactly on "agents
    # alone", which is the point, so the shared endpoint gets one label saying so). Others at
    # the right end, nudged apart so they never collide.
    by = {e[1]: e for e in ends}
    ea = by[SERIES[0][1]][3]
    ax.annotate(f"{SERIES[0][1]}: {ea[0]:.0f}% while connected", xy=(37.5, (ea[1] + ea[2]) / 2),
                xytext=(10, ea[0] + 7), fontsize=9, color=INK, arrowprops=dict(arrowstyle="-", color=SERIES[0][2], lw=1))
    right = [(by[s[1]][0], s) for s in SERIES[1:]]
    right.sort(key=lambda e: e[0])
    placed = []
    for y, (method, label, color, _) in right:
        y2 = y if not placed else max(y, placed[-1] + 4.2)
        placed.append(y2)
        text = f"{y:.0f}%  {label}" + ("\n         = EÄ after the cut" if method == "independent" else "")
        ax.annotate(text, xy=(100, y), xytext=(106, y2), va="center", fontsize=9, color=INK,
                    arrowprops=dict(arrowstyle="-", color=color, lw=1))
    ax.axvline(100, color=INK2, lw=0.8, ls=(0, (3, 3)), zorder=0)
    ax.text(99, 57, "the cut", ha="right", fontsize=9, color=INK2)
    ax.set_xlim(-3, 100)
    ax.set_ylim(0, 60)
    ax.set_xticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%\n(cut)"])
    ax.set_xlabel("Messages lost between agents", color=INK2, fontsize=9.5)
    ax.set_ylabel("Accuracy vs true mood (%)", color=INK2, fontsize=9.5)
    ax.set_title("Better together, fine alone: accuracy as the network is cut", loc="left", fontsize=12, color=INK)
    fig.text(0.01, 0.01, f"Simulator, 200 held-out scenes x {seeds} seeds; bands = min-max over seeds. Chance = 11%.",
             fontsize=8, color=INK2)
    fig.subplots_adjust(left=0.07, right=0.66, top=0.9, bottom=0.17)
    fig.savefig(ARTIFACTS / "resilience.png", facecolor=SURFACE)
    plt.close(fig)

    # 2. Melkor detection (EÄ, rogue on). At the cut no message arrives, so detection is impossible.
    fig, ax = plt.subplots(figsize=(7.5, 4.4), dpi=200)
    fig.patch.set_facecolor(SURFACE)
    style(ax)
    xs, means, los, his = [], [], [], []
    for p in losses:
        d = np.array(det[("ea", p, 1)])
        if np.all(np.isnan(d)):
            continue
        xs.append(100 * p)
        means.append(np.nanmean(d))
        los.append(np.nanmin(d))
        his.append(np.nanmax(d))
    ax.fill_between(xs, los, his, color="#2a78d6", alpha=0.15, lw=0)
    ax.plot(xs, means, color="#2a78d6", lw=2, marker="o", ms=8, markeredgecolor=SURFACE, markeredgewidth=2)
    for x, m, h in zip(xs, means, his):
        ax.annotate(f"{m:.1f}", xy=(x, m), xytext=(0, 9), textcoords="offset points", ha="center", fontsize=9, color=INK)
    ax.text(100, 1.5, "cut: no messages,\nso no new detection.\nExisting flags hold.", ha="right", fontsize=8.5, color=INK2)
    rows = list(csv.DictReader(open(ROOT / "sim/out/results.csv", encoding="utf-8")))
    fp = sum(int(r["false_positive_flags"]) for r in rows)
    ax.set_xlim(-5, 105)
    ax.set_ylim(0, max(his) + 6)
    from matplotlib.ticker import MaxNLocator

    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    ax.set_xticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%\n(cut)"])
    ax.set_xlabel("Messages lost between agents", color=INK2, fontsize=9.5)
    ax.set_ylabel("Bars until every honest agent\nflags Melkor (1 bar = 3.3 s)", color=INK2, fontsize=9.5)
    ax.set_title("Catching Melkor, with zero false accusations", loc="left", fontsize=12, color=INK)
    fig.text(0.01, 0.01, f"Mean, band = min-max over {seeds} seeds. Honest agents falsely flagged: {fp} in {len(rows)} runs.",
             fontsize=8, color=INK2)
    fig.subplots_adjust(left=0.13, right=0.97, top=0.88, bottom=0.2)
    fig.savefig(ARTIFACTS / "detection.png", facecolor=SURFACE)
    print(f"wrote resilience.png and detection.png ({len(rows)} runs, {fp} false flags)")


if __name__ == "__main__":
    main()
