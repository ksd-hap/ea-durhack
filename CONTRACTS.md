# Shared contracts

This is the source of truth for the interfaces between roles. **Don't change anything here without announcing it in the team chat and getting all four people to agree** (build plan, "Shared contracts"). The full plan is in `docs/EA-build-plan.pdf`.

Items marked **[PROPOSED by Role 2]** fill gaps in the plan. Please ack or object at kickoff.

## Fixed musical frame
- The tonal centre is D (MIDI D4 = 62), at 72 BPM in 4/4.
- A scene is 8 bars, and the chord changes every 2 bars: `chord = floor((bar % 8) / 2)`.
- One bar lasts 3333.33 ms.
- Context is `{ mode: 'ionian'|'dorian'|'aeolian', density: 1|2|3 }`. Valence sets the mode: high is ionian, mid is dorian, low is aeolian. Arousal sets the density: low is 1, high is 3.
- `beat` is **0-based** in [0, 4). **[AGREED with Role 3]**
- Start: the hub sets `t0 = now + 5000 ms` (`START_LEAD_MS` = 1.5 bars in `web/core/time.js`), **not** the plan's 2000 ms. Agents plan bar 0 one bar early, at `t0 - 3333 ms`. With a 2000 ms lead that moment has already passed when Start is pressed, so it raced the world's first views: in 5 of 6 browser trials at least one agent played bar 0 in the default mood. A lead of more than one bar removes the race. **[PROPOSED by Role 2]**

## Data files (Role 1 writes; fakes from `tools/make_fake_data.py` until then)
| File | Shape |
|---|---|
| `web/data/agents.json` | `{k, anchors:{valence_pos,valence_neg,arousal_pos,arousal_neg}, agents:{eyeA,poetA,eyeB,poetB:{dim,mu,W,R,R_random,val_mean,val_std,aro_mean,aro_std}}, thresholds:{valence:[lo,hi],arousal:[lo,hi],hysteresis}}` |
| `web/data/scenes.json` | demo scenes `[{id, truth:{mode,density}, views:{eyeA,poetA,eyeB,poetB}, thumb, caption}]` |
| `sim/data/scenes_eval.json` | the 200 held-out scenes, same shape **[PROPOSED path]** |
| `web/data/testvectors.json` | `[{agent, scene, x, z, valence_raw, arousal_raw, valence, arousal, context}]`, computed from the *rounded* exported values **[PROPOSED shape]** |

Perception maths (`web/core/perception.js`, which must match NumPy to 1e-4):
- `z = ((x - mu) @ W) @ R`, then `u = z/|z|`.
- `valence_raw = mean(u·valence_pos) - mean(u·valence_neg)`, and arousal likewise.
- Standardise with the agent's own stats.
- `level = 0 if s<lo, 1 if lo<=s<hi, 2 if s>=hi`.
- Hysteresis: a level changes only when the score leaves its current band by more than `hysteresis`.

## Channels (BroadcastChannel)
**Every name below is per run:** the real channel is `<name>:<session>`, e.g. `ea-net:k3f9x2ab01`. The Stage's runtime picks a random session on each `createRuntime()` and passes it to the world and the agents in `init`. So another Stage tab, or a leftover agent window, is on a different session and can't hear or steer this run. **Channels are created only in `web/channels.js` (`openChannel`); nobody else calls `new BroadcastChannel`.** CI enforces this for all roles. Roles 3 and 4 get everything through the runtime (`rt.onTelemetry`, `rt.cut()`, ...). **[PROPOSED by Role 2]**

| Channel | Direction | Messages | Cut? |
|---|---|---|---|
| `ea-sense-<id>` | world → one agent | `{type:'view', bar, vec}`, sent 2 bars before the scene starts and **re-sent every bar** (same bar gives the same context, so it's idempotent) **[PROPOSED]** | never |
| `ea-hub` | hub → agents and world, rehearsal only | `{type:'start', t0}` (**repeated every 200 ms until acknowledged**; only a new `t0` restarts anything) **[PROPOSED]**, `{type:'useRandomRotation', on}`, `{type:'end'}` **[PROPOSED: end]** | closed at end of rehearsal or on Cut |
| `ea-net` | agent ↔ agent | `{type:'note', ...NoteEvent}`, `{type:'suspect', from, target, score, suspect, bar}`, `{type:'lead', from, bar, mode, density}` (baseline only) **[PROPOSED: suspect/bar fields, lead]** | yes (loss slider, Cut) |
| `ea-netem` | experimenter → transport | `{type:'loss', p}` | never; agent logic never sees it |
| `ea-telemetry` | agents and world → Stage, one way | see below | never; agents never subscribe |

## NoteEvent
```js
{ from:'eyeA', at: 1731600000123.5,   // absolute ms = performance.timeOrigin + performance.now() timeline
  bar: 41, beat: 2.5, pitch: 62, vel: 0.7, dur: 0.5 /* beats */, role: 'architect', rogue: false }
```
Agents plan bar n+1 while bar n sounds. Audio converts once: `offset = ctx.currentTime - (performance.timeOrigin + performance.now())/1000`, then `time = at/1000 + offset`.

## Telemetry messages (what Roles 3 and 4 consume)
| type | fields | from |
|---|---|---|
| `note` | NoteEvent | each agent, every note it plays |
| `ctx` | `from, bar, mode, density, own:{mode,density}, followingLeader` | each agent, every bar |
| `ghost` | `from, about, bar, beat, pitch` | peer-model predictions |
| `status` | `from, bar, rogue, baseline, randomRotation, response:'normal'\|'absorb'\|'defend', suspected:[ids], flagged:[ids], barsSilent` **[PROPOSED]** | each agent, every bar |
| `rx` | `from, count, dropped, total, loss` (count and dropped are per 1 s interval) | transport, every 1 s |
| `scene` | `index, bar, id, truth, thumb, caption` **[PROPOSED]** | world, when a scene starts |
| `started` | `from, t0` (from is an agent id or `'world'`) **[PROPOSED]** | each agent and the world, on every `start` they receive |

## Metrics (`web/metrics.js`, one definition for the Stage and the simulator)
Role 4's metrics panel and `sim/engine.mjs` both compute every number through `createMetrics()`, so the panel cannot disagree with the slides. Don't reimplement any formula in `stage.js`.
```js
import { createMetrics } from './metrics.js';
const m = createMetrics({ rollingBars: 8 });
rt.onTelemetry((msg) => m.ingest(msg, Date.now()));
const s = m.snapshot(Date.now());
// s.phase 'Halls'|'Void', s.rxLast10s, s.bar, s.scene {id, truth, thumb, caption},
// s.agents[id] {mode, density, correct, rogue, melkor: 'none'|'suspected'|'flagged'},
// s.rolling {accuracy, mode_accuracy, agreement, mode_agreement, consonance, prediction_match, bars}
```
- **Definitions** are in the file header, computed over honest agents per bar.
- **Consonance** counts all sounding notes, Melkor's included, against the honest majority's mode. On a tie, no mode is privileged.
- **Window.** Values are over the last 8 closed bars. A bar closes when telemetry for a later bar arrives.
- `web/dev/harness.html` shows a working panel. Agent code never imports this file (isolation check).

## Main thread → agent worker (fault injection only)
`{cmd:'init', id, seed, session}`, `{cmd:'setRogue', on}`, `{cmd:'setBaseline', on}`, `{cmd:'resetFlags'}` **[PROPOSED: resetFlags, sent by Restore]**. Never musical information. Enforced by `tools/check_isolation.sh`.

## Agent core (`web/core/agent.js`)
```js
createAgent({ id, role, params, anchors, thresholds, seed })
  .onView(bar, vec) .onPeer(msg) .planBar(bar, {t0}?) -> { notes, outbox, telemetry }
  .setRogue(on) .setBaseline(on)
  .setRandomRotation(on) .resetFlags() .inspect()     // [PROPOSED extensions]
```

## compose() (Role 3 owns `web/core/compose.js`; Role 2 calls it) **[AGREED with Role 3 — awaiting final ack]**
```js
compose({ id, role, bar, ctx, state, rng, predictions, lastBarNotes, absorb, defend, rogue })
  -> { notes: [{ beat, pitch, dur, vel }], state }
```
A worked example lives in `web/core/compose.example.json`, and `tests/compose.contract.test.mjs` checks the real `compose()` against it on every PR.
- `ctx` is `{mode, density}`, the agent's **own** context. The chord slot is `floor((bar % 8) / 2)`.
- `state` is whatever compose returned last bar (`{}` the first time), holding things like the motif and previous notes. Don't mutate it; return a new one.
- `rng` is a seeded `() => [0,1)` owned by the agent, and the only source of randomness.
- `predictions`: `[{peer, role, bar, slot, beat, pc, pitch, count}]`. `slot` is the eighth-note slot (0 to 7), `beat = slot/2`, and `pc` is absolute (C = 0).
- `lastBarNotes` holds the NoteEvents received from peers for `bar - 1`.
- `absorb`: `null | {pcs: [absolute pcs]}`, e.g. 3 = E♭ and 8 = G♯.
- **Honest notes may leave the three D modes only to answer a rogue.** The only pitch classes outside all three modes are E♭ and G♯, and they are the Melkor detector's evidence. An honest note may use them **only** when `absorb` is set, and only the pitch classes in `absorb.pcs`. So the Neapolitan (E♭ major) answering a rogue E♭ and E7 answering a rogue G♯ are fine; any other outside note would get the agent flagged. The detector excuses an E♭/G♯ from agent X only when the receiver already suspects another agent of playing that note, or hears another agent reporting one (never on X's own word). `tests/compose.contract.test.mjs` checks this rule on every PR. **[AGREED fix; Role 1 found the conflict]**
- Output notes: `beat` is 0-based in [0,4) (musical beats 1 and 3 are 0 and 2), `pitch` is MIDI, `dur` is in beats and > 0, and `vel` is in (0,1].
- The **agent wrapper** adds `from`, `bar`, `at` (absolute ms), `role` and `rogue`.
- Pure: no audio, timers, browser APIs or `Math.random`. That way it also runs in the simulator.

## Runtime API for the Stage (`web/runtime.js`, Role 2)
```js
const rt = await createRuntime({ seed });   // rt.session: this run's channel suffix
rt.onTelemetry(fn); const t0 = rt.start(); await rt.started; // resolves when all 4 agents + world acknowledged
rt.endRehearsal(); rt.setRandomRotation(on);
rt.setLoss(p); rt.cut(); rt.restore(); rt.setRogue('poetB', on); rt.setBaseline(on);
```

**Several Stage tabs no longer interfere** (each run has its own session), but for the demo still keep one Stage tab open, so there's only one sound output.
