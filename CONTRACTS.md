# Shared contracts

This is the source of truth for the interfaces between roles. **Don't change anything here without announcing it in the team chat and getting all four people to agree** (build plan, "Shared contracts"). The full plan is in `docs/EA-build-plan.pdf`.

Items marked **[PROPOSED by Role 2]** fill gaps in the plan. Please ack or object at kickoff.

## Fixed musical frame
- The tonal centre is D (MIDI D4 = 62), at 72 BPM in 4/4.
- A scene is 8 bars, and the chord changes every 2 bars: `chord = floor((bar % 8) / 2)`.
- One bar lasts 3333.33 ms.
- Context is `{ mode: 'ionian'|'dorian'|'aeolian', density: 1|2|3 }`. Valence sets the mode: high is ionian, mid is dorian, low is aeolian. Arousal sets the density: low is 1, high is 3.
- `beat` is **0-based** in [0, 4). **[PROPOSED]**

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
| Channel | Direction | Messages | Cut? |
|---|---|---|---|
| `ea-sense-<id>` | world → one agent | `{type:'view', bar, vec}` | never |
| `ea-hub` | hub → agents and world, rehearsal only | `{type:'start', t0}`, `{type:'useRandomRotation', on}`, `{type:'end'}` **[PROPOSED: end]** | closed at end of rehearsal or on Cut |
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

## Main thread → agent worker (fault injection only)
`{cmd:'init', id, seed}`, `{cmd:'setRogue', on}`, `{cmd:'setBaseline', on}`, `{cmd:'resetFlags'}` **[PROPOSED: resetFlags, sent by Restore]**. Never musical information. Enforced by `tools/check_isolation.sh`.

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
- Output notes: `beat` is 0-based in [0,4) (musical beats 1 and 3 are 0 and 2), `pitch` is MIDI, `dur` is in beats and > 0, and `vel` is in (0,1].
- The **agent wrapper** adds `from`, `bar`, `at` (absolute ms), `role` and `rogue`.
- Pure: no audio, timers, browser APIs or `Math.random`. That way it also runs in the simulator.

## Runtime API for the Stage (`web/runtime.js`, Role 2)
```js
const rt = await createRuntime({ seed });
rt.onTelemetry(fn); rt.start(); rt.endRehearsal(); rt.setRandomRotation(on);
rt.setLoss(p); rt.cut(); rt.restore(); rt.setRogue('poetB', on); rt.setBaseline(on);
```
