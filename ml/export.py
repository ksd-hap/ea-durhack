"""Export the fitted alignment and scenes in the shared-contract formats (CONTRACTS.md).

Writes (values rounded to 5 decimals):
  web/data/agents.json        k, anchors, per-agent mu/W/R/R_random + score stats, thresholds
                              (+ stats_by_method: fitted / ridge / random, so the random-rotation
                              control is standardised with its OWN statistics)
  web/data/scenes.json        48 demo scenes: per-agent views, caption truth, thumbnail, caption
  web/img/<id>.jpg            demo thumbnails (320 px)
  sim/data/scenes_eval.json   the 200 held-out scenes for the simulator
  web/data/testvectors.json   3 held-out scenes per agent: expected z / valence / arousal / context
                              for the fitted map AND the random control, computed from the
                              ROUNDED exported values, so JS-vs-NumPy tests arithmetic only
  web/data/provenance.json    exact COCO ids per split, models, versions, settings

Demo scenes are chosen from the keyword candidate pool by caption-based truth ONLY (never by
agent agreement), round-robin over the 9 (mode, density) cells in a performance arc.

    python -m ml.export
"""

import json

import numpy as np
from PIL import Image

from ml.common import AGENTS, CACHE, DEC, IMAGES, K, MODELS, MODES, N_DEMO, ROOT, SEED, level, load_manifest, save_json, unit_rows

# Arc: calm dawn, busy city, storm, night, celebration, then the rest.
ARC = [("ionian", 1), ("dorian", 3), ("aeolian", 3), ("aeolian", 1), ("ionian", 3),
       ("dorian", 1), ("ionian", 2), ("aeolian", 2), ("dorian", 2)]
STAT_KEYS = ("val_mean", "val_std", "aro_mean", "aro_std")


def r5(x):
    return np.round(np.asarray(x, dtype=np.float64), DEC)


def scores(Z, anchors):
    U = unit_rows(Z)
    v = (U @ anchors["valence_pos"].T).mean(-1) - (U @ anchors["valence_neg"].T).mean(-1)
    a = (U @ anchors["arousal_pos"].T).mean(-1) - (U @ anchors["arousal_neg"].T).mean(-1)
    return v, a


def ctx(v, a, th):
    return {"mode": MODES[int(level(v, *th["valence"]))], "density": int(level(a, *th["arousal"])) + 1}


def main():
    rows = load_manifest()
    f = np.load(CACHE / "fit.npz")
    meta = json.loads((CACHE / "fit.json").read_text())
    X = {ag: np.load(CACHE / f"{ag}.npy").astype(np.float64) for ag in AGENTS}
    th = {"valence": [round(x, DEC) for x in meta["thresholds"]["valence"]],
          "arousal": [round(x, DEC) for x in meta["thresholds"]["arousal"]], "hysteresis": 0.1}
    anchors = {p: r5(f[f"anchor_{p}"]) for p in ("valence_pos", "valence_neg", "arousal_pos", "arousal_neg")}

    # Caption-based truth for every row (Poet-A frame, truth's own calibration stats).
    T = (np.load(CACHE / "truth.npy").astype(np.float64) - f["poetA_mu"]) @ f["poetA_W"]
    tv, ta = scores(T, {p: f[f"anchor_{p}"] for p in anchors})
    ts = meta["truth_stats"]
    truth = [ctx((v - ts["val_mean"]) / ts["val_std"], (a - ts["aro_mean"]) / ts["aro_std"], meta["thresholds"]) for v, a in zip(tv, ta)]

    agents = {}
    for ag in AGENTS:
        st = {m: {k: round(meta["stats"][ag][m][k], DEC) for k in STAT_KEYS} for m in ("fitted", "ridge", "random")}
        agents[ag] = {"dim": int(X[ag].shape[1]), "mu": r5(f[f"{ag}_mu"]).tolist(), "W": r5(f[f"{ag}_W"]).tolist(),
                      "R": r5(f[f"{ag}_R"]).tolist(), "R_random": r5(f[f"{ag}_R_random"]).tolist(),
                      **st["fitted"], "stats_by_method": st}
    # Belief sharing: an agent fuses its standardised (valence, arousal) with the peers' it heard,
    # f = mean over the subset. Averaging shrinks the spread, so f is rescaled by the std of that
    # subset's mean on CALIBRATION scenes. One factor pair per subset of agents, per method.
    fusion = {}
    cal = np.array([r["split"] == "calibration" for r in rows])
    for method, key in (("fitted", "R"), ("random", "R_random")):
        S = []
        for ag in AGENTS:
            Z = ((X[ag][cal] - f[f"{ag}_mu"]) @ f[f"{ag}_W"]) @ f[f"{ag}_{key}"]
            v, a = scores(Z, {p: f[f"anchor_{p}"] for p in anchors})
            st = meta["stats"][ag][method]
            S.append(np.stack([(v - st["val_mean"]) / st["val_std"], (a - st["aro_mean"]) / st["aro_std"]], -1))
        S = np.stack(S, 1)  # (n_cal, 4, 2)
        fusion[method] = {}
        for mask in range(1, 16):
            sub = [i for i in range(4) if mask >> i & 1]
            fusion[method]["+".join(AGENTS[i] for i in sub)] = [round(float(x), DEC) for x in S[:, sub].mean(1).std(0)]
    agents_json = {"k": K, "anchors": {p: m.tolist() for p, m in anchors.items()}, "agents": agents, "thresholds": th,
                   "fusion": fusion,
                   "source": {"method": "procrustes", "k": meta["k"], "seed": SEED, "models": MODELS}}
    save_json(ROOT / "web/data/agents.json", agents_json)

    def scene(i, thumb):
        r = rows[i]
        return {"id": r["id"], "truth": truth[i], "views": {ag: r5(X[ag][i]).tolist() for ag in AGENTS},
                "thumb": thumb, "caption": r["captions"][0]}

    # Demo: caption truth ONLY (agents' outputs play no part), round-robin over the arc's cells,
    # clearest caption mood first. Clarity = how far the standardised truth scores sit inside
    # their tertile band on BOTH axes: min over valence/arousal of the distance to the nearest
    # boundary of the band. Clear-cut scenes make the performance legible; ambiguous ones
    # (near a boundary) are left for the held-out evaluation, which uses all 200 regardless.
    sv = (tv - ts["val_mean"]) / ts["val_std"]
    sa = (ta - ts["aro_mean"]) / ts["aro_std"]

    def inside(s, lo, hi):
        lv = int(level(s, lo, hi))
        return lo - s if lv == 0 else (min(s - lo, hi - s) if lv == 1 else s - hi)

    clarity = np.array([min(inside(v, *meta["thresholds"]["valence"]), inside(a, *meta["thresholds"]["arousal"])) for v, a in zip(sv, sa)])
    cand = [i for i, r in enumerate(rows) if r["split"] == "candidate"]
    by_cell = {c: sorted((i for i in cand if (truth[i]["mode"], truth[i]["density"]) == c), key=lambda i: -clarity[i]) for c in ARC}
    demo = []
    while len(demo) < N_DEMO and any(by_cell.values()):
        for c in ARC:
            if by_cell[c] and len(demo) < N_DEMO:
                demo.append(by_cell[c].pop(0))
    (ROOT / "web/img").mkdir(parents=True, exist_ok=True)
    for i in demo:
        im = Image.open(IMAGES / rows[i]["file"]).convert("RGB")
        im.thumbnail((320, 320))
        im.save(ROOT / f"web/img/{rows[i]['id']}.jpg", quality=80, optimize=True)
    save_json(ROOT / "web/data/scenes.json", [scene(i, f"img/{rows[i]['id']}.jpg") for i in demo])
    ev = [i for i, r in enumerate(rows) if r["split"] == "evaluation"]
    save_json(ROOT / "sim/data/scenes_eval.json", [scene(i, None) for i in ev])

    # Test vectors from the ROUNDED exported numbers.
    A = json.loads((ROOT / "web/data/agents.json").read_text())
    anc = {p: unit_rows(np.array(m)) for p, m in A["anchors"].items()}
    tests = []
    for ag in AGENTS:
        p = A["agents"][ag]
        for i in ev[:3]:
            x = r5(X[ag][i])
            base = (x - np.array(p["mu"])) @ np.array(p["W"])
            case = {"agent": ag, "scene": rows[i]["id"], "x": x.tolist()}
            for name, R, st in (("fitted", p["R"], p["stats_by_method"]["fitted"]), ("random", p["R_random"], p["stats_by_method"]["random"])):
                z = base @ np.array(R)
                v, a = scores(z, anc)
                vs, as_ = (v - st["val_mean"]) / st["val_std"], (a - st["aro_mean"]) / st["aro_std"]
                out = {"z": z.tolist(), "valence_raw": float(v), "arousal_raw": float(a), "valence": float(vs),
                       "arousal": float(as_), "context": ctx(vs, as_, A["thresholds"])}
                if name == "fitted":
                    case.update(out)
                else:
                    case["random"] = out
            tests.append(case)
    save_json(ROOT / "web/data/testvectors.json", tests)

    versions = json.loads((CACHE / "embed_versions.json").read_text())
    prov = {"seed": SEED, "k": meta["k"], "ridge_alpha": meta["ridge_alpha"], "models": MODELS, "versions": versions,
            "eye_b_crop": "seeded random crop, 70% of area, rng = default_rng([0, image_id])",
            "poets": {"poetA": "caption 1 of 5", "poetB": "caption 2 of 5"}, "truth": "mpnet mean of all 5 captions",
            **{f"{s}_ids": [r["id"] for r in rows if r["split"] == s] for s in ("calibration", "evaluation", "candidate")},
            "demo_ids": [rows[i]["id"] for i in demo],
            "demo_selection": "caption truth only: round-robin over 9 cells in arc order, clearest caption mood first (min distance of standardised truth scores to their tertile boundaries)"}
    save_json(ROOT / "web/data/provenance.json", prov, compact=False)

    cells = {}
    for i in demo:
        k = f"{truth[i]['mode']}/{truth[i]['density']}"
        cells[k] = cells.get(k, 0) + 1
    for path in ("web/data/agents.json", "web/data/scenes.json", "sim/data/scenes_eval.json", "web/data/testvectors.json"):
        print(f"wrote {path} ({(ROOT / path).stat().st_size / 1e6:.2f} MB)")
    print(f"demo: {len(demo)} scenes, cells {cells}")
    print("first arc:", [f"{truth[i]['mode']}/{truth[i]['density']}: {rows[i]['captions'][0]}" for i in demo[:5]])


if __name__ == "__main__":
    main()
