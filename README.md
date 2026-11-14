# EÄ

Four AI agents that were never trained together compose music and paint a shared world. They keep doing it coherently after the network is cut, and they survive a corrupted agent (Melkor). Live metrics back each claim. Built at DurHack 2026.

> The plan is in [`docs/EA-build-plan.pdf`](docs/EA-build-plan.pdf). Interfaces are in [`CONTRACTS.md`](CONTRACTS.md). Deadline: **Sun 15 Nov 12:00, submit by 11:00, code freeze 10:00.**

## Run it (offline, no CDN)
```bash
cd web
python -m http.server 8000
```
Open http://localhost:8000. Workers don't load over `file://`. Each run gets private channels, so stray tabs can't interfere, but keep one Stage tab open for a single sound output. **Never create a `BroadcastChannel` yourself.** Use the runtime API (`rt.onTelemetry`, etc.); CI rejects hard-coded channels.

**While developing, use the no-cache server instead.** Plain `http.server` lets the browser keep running your *old* JavaScript after an edit:
```bash
python tools/serve.py
```
This serves `web/` on :8000. Add `--root .` to serve the repo root.

Dev pages (serve from the **repo root** instead, so `sim/` is reachable):
- `http://localhost:8000/web/dev/selftest.html` runs the JS-vs-NumPy check, the false-positive test and the detection test in the browser, with no Node needed.
- `http://localhost:8000/web/dev/harness.html` is the live runtime. Use it to Start, Corrupt Pulse, Cut, Restore and set loss, and to watch the agent table.

### Agents in separate windows (stretch)
Open `http://localhost:8000/web/dev/harness.html?agents=windows` (served from the repo root) and click each agent's button to open its window. Start becomes available once all four show ●. Each window hosts one agent Worker; the Stage keeps the world, sound and painting. Demo beat: close one agent's window mid-performance and the other three carry on.

## Who owns what
| Role | Owns | Branch |
|---|---|---|
| 1. ML and alignment | `ml/`, `web/data/*.json`, `sim/data/`, results slide | `role1-ml` |
| 2. Agents, network, simulation | `web/core/{agent,perception,linalg,rng,time}.js`, `web/transport.js`, `web/*.worker.js`, `web/runtime.js`, `web/telemetry-out.js`, `sim/`, `tools/check_isolation.sh` | `role2-agents` |
| 3. Sound and composition | `web/core/compose.js`, `web/audio.js`, `web/vendor/tone.js`, `web/core/theory.js` (shared; tell Role 2 before changing scales) | `role3-sound` |
| 4. Painting, Stage, demo | `web/index.html`, `web/stage.js`, `web/paint.js`, slides, video, README polish | `role4-stage` |

Everyone builds against the **fake data** already in the repo (`py tools/make_fake_data.py` regenerates it). Role 1's real export overwrites the same paths.

## Workflow
- One branch per role. Merge to `main` through **small PRs**. Never force-push `main`. `main` must always run.
- Integrate at the gates: **20:00, 23:00, 02:30, 06:00, 09:00**.
- Before every merge, run:
  ```bash
  bash tools/check_isolation.sh
  ```
  ```bash
  node --test tests/
  ```
  If you don't have Node, open `web/dev/selftest.html` instead. CI runs both on every PR.
- Tag each ship state: `v0-g2`, `v1-g3`, `v2-g4`, `final`.
- Contract changes are announced in the team chat first, and all four agree.

## Simulator (Role 2)
```bash
node sim/sim.mjs
```
This writes `sim/out/results.csv` and `summary.csv`. The grid is method (EÄ, baseline, random rotation) × loss (0, 0.25, 0.5, 0.75, 1) × rogue (off, on) × 10 seeds. Quick run: `node sim/sim.mjs --seeds 2 --scenes 40`.

## Layout
```
ml/            embed.py fit_align.py eval.py export.py (Role 1)
web/index.html the Stage            web/stage.js  UI + metrics (R4)   web/paint.js (R4)
web/audio.js   Tone.js (R3)         web/core/compose.js music (R3)
web/core/agent.js perception.js linalg.js rng.js time.js theory.js  (R2, pure, no I/O)
web/agent.worker.js world.worker.js transport.js runtime.js telemetry-out.js  (R2)
web/data/      agents.json scenes.json testvectors.json  (R1; fake for now)
sim/           engine.mjs sim.mjs data/scenes_eval.json  (R2)
tests/         node --test       tools/  check_isolation.sh make_fake_data.py
```
