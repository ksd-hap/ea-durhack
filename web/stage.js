/**
 * stage.js: the Stage UI, metrics panel and controls (Role 4)
 * ----------------------------------------------------------------------------
 * THE ISOLATION RULE (judges will ask; tools/check_isolation.sh enforces it):
 *   The Stage only DRAWS, PLAYS SOUND and INJECTS FAULTS. It never sends musical
 *   information to agents. Every control goes through Role 2's runtime.js
 *   (start, endRehearsal, setRandomRotation, setLoss, cut, restore, setRogue,
 *   setBaseline), and every metric on the panel is computed ONLY from
 *   ea-telemetry, which agents never read.
 *
 * Run it from the repo root:   npm run serve     (or: cd web && python -m http.server 8000)
 *   http://localhost:8000/          the Stage
 *   http://localhost:8000/?debug    plus the debug overlay (or press ` at any time)
 * In the browser console:  EA.state, EA.painter.stats(), EA.metrics(), EA.rt
 *
 * Message shapes are in CONTRACTS.md, "Telemetry messages".
 * Grep tags: CUSTOMISE / DEBUG / CONTRACT / INTEGRATE (where Role 3 code plugs in)
 * ----------------------------------------------------------------------------
 */
import { createPainter, BAR_MS, LAYERS } from './paint.js';
import { createRuntime } from './runtime.js';
import { createMetrics } from './metrics.js'; // Role 2's shared metrics: the ONE definition of every panel number

// ---- Config -----------------------------------------------------------------
const AGENTS = [ // CONTRACT: agent ids and roles from page 1 of the plan
  { id: 'eyeA',  role: 'architect', label: 'Eye-A' },
  { id: 'poetA', role: 'melodist',  label: 'Poet-A' },
  { id: 'eyeB',  role: 'weaver',    label: 'Eye-B' },
  { id: 'poetB', role: 'pulse',     label: 'Poet-B' },
];
const ROGUE_TARGET = 'poetB';        // the agent the Corrupt button turns into Melkor
const ROLLING_BARS = 8;              // CONTRACT: metrics.js window (8 bars, about 27 s), as agreed in CONTRACTS.md
const METRICS_EVERY_MS = 500;        // CUSTOMISE: panel refresh rate
const SEED = 0;                      // CUSTOMISE: runtime seed; change it for a different performance
const metrics = createMetrics({ rollingBars: ROLLING_BARS });

// Pitch class relative to D (MIDI 62): used only to match ghosts to notes for the painting's dots.
const relD = (p) => (((p - 62) % 12) + 12) % 12;

let DEBUG = new URLSearchParams(location.search).has('debug');
// PHONES (added by Role 2): ?phones runs the agents on 4 phones (phone.html) instead of in this page.
// Serve with `node tools/phone-server.mjs`. The Stage then only paints and shows metrics; it stays
// SILENT, because every phone plays its own agent's voice.
const PHONES = new URLSearchParams(location.search).has('phones');
const dbg = (...a) => DEBUG && console.log('[stage]', ...a); // DEBUG: logs only when debug is on
const nowAbs = () => performance.timeOrigin + performance.now();
const $ = (sel) => document.querySelector(sel);

// ---- State (window.EA.state in the console) -------------------------------------
const state = {
  started: false, hubOpen: true, loss: 0, rogueOn: false, baselineOn: false, randomRot: false,
  t0: null, maxBarSeen: -1,
  ctxHist: Object.fromEntries(AGENTS.map((a) => [a.id, []])), // agent -> [{bar, mode, density}]
  scenes: [],               // [{index, bar, id, truth, thumb, caption}], sorted by bar
  rx: [],                   // [{t, count}] for the 10 s window
  notes: [],                // recent notes: [{bar, pitch, from, rogue}]
  ghostsPending: new Map(), // "about|bar|slot" -> ghost
  ghostResults: [],         // [{bar, hit}]
  status: {},               // agentId -> its latest status telemetry
  msgCounts: {},            // DEBUG: telemetry count by type
  unknown: 0,               // DEBUG: messages with a type we don't handle
};

// ---- Painter, audio, runtime ------------------------------------------------------------
// Three painters with the same API. CUSTOMISE: pick the default here.
//   scene (default):  paint-scene.js, a living landscape redrawn every frame, with a legend,
//                     note pulses and "View as" an agent
//   ?painter=p5:      paint-p5.js, p5.brush watercolour that piles up
//   ?painter=canvas:  paint.js, plain canvas, 7 layers (Solo buttons work)
const PAINTER = new URLSearchParams(location.search).get('painter') || 'scene';
let painter;
try {
  if (PAINTER === 'canvas') painter = createPainter($('#paint'), { seed: 1 });
  else if (PAINTER === 'p5') painter = await (await import('./paint-p5.js')).createP5Painter($('#paint'), { seed: 1 });
  else painter = await (await import('./paint-scene.js')).createScenePainter($('#paint'), { seed: 1 });
} catch (err) {
  // DEBUG: if a painter fails to load, fall back to the plain painter so the demo still runs.
  console.error('[stage] painter failed, using plain canvas', err);
  painter = createPainter($('#paint'), { seed: 1 });
}
painter.start();

let audio = null; // INTEGRATE (Role 3): audio.js exports createAudio() -> { start(), onNote(note) }
let rt = null;    // Role 2's runtime, created at boot so Start is instant

// =============================================================================
// INGEST: every telemetry message comes through here, and nowhere else
// =============================================================================
function ingest(m) {
  if (!m || typeof m !== 'object') return;
  const type = m.type ?? 'unknown';
  state.msgCounts[type] = (state.msgCounts[type] || 0) + 1;
  if (typeof m.bar === 'number' && m.bar > state.maxBarSeen) state.maxBarSeen = m.bar;
  metrics.ingest(m, Date.now());                       // the shared metrics see every message first

  switch (type) {
    case 'started': // {from, t0}: an agent or the world acknowledged Start (runtime handles it)
      break;
    case 'note': { // CONTRACT: NoteEvent
      painter.enqueueNote(m);
      audio?.onNote?.(m);
      state.notes.push({ bar: m.bar, pitch: m.pitch, from: m.from, rogue: !!m.rogue });
      if (state.notes.length > 4000) state.notes.splice(0, 2000);
      // Ghost matching: same predicted agent, same bar, same eighth slot, same pitch class.
      const key = `${m.from}|${m.bar}|${Math.round(m.beat * 2)}`;
      const gh = state.ghostsPending.get(key);
      if (gh && relD(gh.pitch) === relD(m.pitch)) {
        painter.ghostHit(gh);
        state.ghostResults.push({ bar: gh.bar, hit: true });
        state.ghostsPending.delete(key);
      }
      break;
    }
    case 'ctx': // {from, bar, mode, density, own, followingLeader}
      painter.setContext(m.from, m.mode, m.density);
      state.ctxHist[m.from]?.push({ bar: m.bar, mode: m.mode, density: m.density });
      if (state.ctxHist[m.from]?.length > 400) state.ctxHist[m.from].splice(0, 200);
      break;
    case 'ghost': // {from, about, bar, beat, pitch}
      painter.drawGhost(m);
      state.ghostsPending.set(`${m.about}|${m.bar}|${Math.round(m.beat * 2)}`, m);
      break;
    case 'rx': // {from, count, dropped, total, loss}; count is per 1 s interval
      state.rx.push({ t: performance.now(), count: m.count || 0 });
      break;
    case 'scene': // {index, bar, id, truth, thumb, caption}
      state.scenes.push(m);
      state.scenes.sort((a, b) => a.bar - b.bar);
      if (state.scenes.length > 100) state.scenes.shift();
      painter.setCaption?.(m.caption);   // the scene's caption, shown on the painting (scene painter)
      break;
    case 'status': // {from, bar, rogue, baseline, response, suspected:[ids], flagged:[ids], barsSilent}
      state.status[m.from] = m;
      // Kintsugi: an honest agent is absorbing Melkor, so gold seams start mending his slashes.
      if (m.response === 'absorb' && !m.rogue) painter.setKintsugi(true);
      break;
    default:
      state.unknown++;
      dbg('unknown telemetry', m); // DEBUG: contract mismatch? Check the type spelling in CONTRACTS.md.
  }
}

// =============================================================================
// METRICS: computed only from telemetry (CONTRACT)
// =============================================================================
const currentBar = () => (state.t0 != null ? Math.floor((nowAbs() - state.t0) / BAR_MS) : state.maxBarSeen);

// CONTRACT: every number on the panel comes from Role 2's shared web/metrics.js (the same code
// the simulator uses for the slides), so the panel can never disagree with the results slide.
// Don't re-implement any formula here. ingest() feeds it every telemetry message.
//   snapshot shape: phase 'Halls'|'Void', rxLast10s, bar, scene {truth, thumb, caption},
//   agents[id] {mode, density, correct, rogue, melkor}, rolling {accuracy, agreement, consonance, prediction_match}
function computeMetrics() {
  const s = metrics.snapshot(Date.now());
  // Ghost matching for the PAINTING (dots filling in) stays here: it's drawing, not a metric.
  const bar = currentBar();
  for (const [k, gh] of state.ghostsPending) if (gh.bar < bar - 1) state.ghostsPending.delete(k);
  return { ...s, phase: state.started ? s.phase : '—' };
}

// ---- Render the panel ------------------------------------------------------------
const fmtPct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
// Plain words instead of music jargon. Mode → how the scene feels; density → how busy it is.
// CUSTOMISE: the words. (The music term is still in the hover tooltip of each badge.)
const MOOD_WORD = { ionian: 'Bright', dorian: 'Wistful', aeolian: 'Dark' };
const DENSITY_WORD = { 1: 'calm', 2: 'flowing', 3: 'busy' };
const fmtCtx = (c) => (c ? `${MOOD_WORD[c.mode] || c.mode} · ${DENSITY_WORD[c.density] || c.density}` : '—');
const PHASE_TEXT = { Halls: 'Connected', Void: 'Cut off', '—': 'Not started' };
// metrics.js gives, per agent, whether the OTHER agents have caught it as Melkor.
const MELKOR_TEXT = { none: 'no', suspected: 'suspected…', flagged: 'caught' };

function renderMetrics() {
  const M = computeMetrics();
  const R = M.rolling || {};
  $('#m-phase').textContent = PHASE_TEXT[M.phase] || M.phase;
  $('#m-phase').dataset.phase = M.phase;
  $('#m-bar').textContent = M.bar ?? '—';
  $('#m-rx').textContent = M.rxLast10s;
  $('#m-agree').textContent = fmtPct(R.agreement);
  $('#m-acc').textContent = fmtPct(R.accuracy);
  $('#m-ghost').textContent = fmtPct(R.prediction_match);
  $('#m-cons').textContent = fmtPct(R.consonance);

  const t = M.scene?.truth;
  $('#m-truth').textContent = t ? fmtCtx(t) : '—';
  $('#m-caption').textContent = M.scene?.caption || '';
  const img = $('#m-thumb');
  if (M.scene?.thumb && img.dataset.src !== M.scene.thumb) { img.src = M.scene.thumb; img.dataset.src = M.scene.thumb; img.hidden = false; }
  if (!M.scene?.thumb) img.hidden = true;

  for (const a of AGENTS) {
    const c = M.agents?.[a.id];
    const row = $(`#row-${a.id}`);
    row.querySelector('.ctx').textContent = fmtCtx(c);
    row.querySelector('.tick').textContent = c && c.correct != null ? (c.correct ? '✓' : '✗') : '';
    row.querySelector('.tick').dataset.ok = c?.correct ? '1' : '0';
    // "Caught as Melkor?": has this agent been suspected or caught by the others?
    const mk = c?.melkor || 'none';
    row.querySelector('.mk').textContent = c?.rogue && mk === 'none' ? 'not yet' : MELKOR_TEXT[mk];
    row.querySelector('.mk').dataset.state = mk;
    const badge = $(`#badge-${a.id}`);
    badge.querySelector('.b-ctx').textContent = fmtCtx(c);
    badge.title = c ? `${c.mode}, density ${c.density}. Click to see the painting through this agent's eyes` : '';
    badge.dataset.rogue = state.rogueOn && a.id === ROGUE_TARGET ? '1' : '0';
  }
  renderThreads();
  if (DEBUG) renderDebug(M);
}

// ---- Threads between badges: they fade with loss and snap at high loss -------------------
function renderThreads() {
  const svg = $('#threads');
  const box = svg.getBoundingClientRect();
  const centres = AGENTS.map((a) => {
    const r = $(`#badge-${a.id}`).getBoundingClientRect();
    return [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
  });
  const opacity = Math.max(0, 1 - state.loss);
  const snapped = state.loss > 0.8; // CUSTOMISE: the loss level where threads count as "snapped"
  let html = '';
  for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) {
    const [x1, y1] = centres[i], [x2, y2] = centres[j];
    const ym = Math.min(y1, y2) + 18 + (j - i) * 9;  // arc downward a little; longer links sag further
    html += `<path d="M${x1},${y1} Q${(x1 + x2) / 2},${ym} ${x2},${y2}" class="thread${snapped ? ' snapped' : ''}" style="opacity:${snapped ? 0.35 : opacity}"/>`;
  }
  svg.innerHTML = html;
}

// ---- Debug overlay (press `) ------------------------------------------------------
function renderDebug(M) {
  const s = painter.stats();
  $('#debug').textContent = [
    `fps ${s.fps}   queued ${s.queued}   painted ${s.painted}   late ${s.late}`,
    `per layer ${LAYERS.map((l) => `${l}:${s.perLayer[l]}`).join(' ')}`,
    `ghosts drawn ${s.ghosts} hits ${s.ghostHits}   pending ${state.ghostsPending.size}`,
    `telemetry ${JSON.stringify(state.msgCounts)}   unknown ${state.unknown}`,
    `bar ${M.bar}  t0 ${state.t0 ? Math.round(state.t0) : '—'}  loss ${state.loss}  hub ${state.hubOpen}  rogue ${state.rogueOn}  baseline ${state.baselineOn}  rr ${state.randomRot}`,
    `heap ${performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) + ' MB' : 'n/a'}  (watch this during the 20 min soak test)`,
  ].join('\n');
}

// =============================================================================
// CONTROLS: every action goes through rt (Role 2's runtime.js)
// =============================================================================
function setLoss(p) {
  state.loss = p;
  rt?.setLoss(p);
  // Tell the painter when comms are fully cut, so Melkor's crack spreads faster and can't be mended.
  // This is display only: the painter is not an agent, and agents never see it.
  painter.setIsolated?.(p >= 0.99);
  $('#loss').value = p;
  $('#loss-val').textContent = p.toFixed(2);
  updateButtons();
}
function updateButtons() {
  const ready = !!rt;
  for (const id of ['#btn-rehearse', '#btn-cut', '#btn-restore', '#btn-corrupt', '#btn-baseline', '#loss']) $(id).disabled = !ready;
  $('#btn-rehearse').disabled = !ready || !state.hubOpen;
  $('#btn-rr').disabled = !ready || !state.hubOpen || !state.started; // random rotation only during rehearsal
  $('#btn-rr').classList.toggle('on', state.randomRot);
  $('#btn-corrupt').classList.toggle('on', state.rogueOn);
  $('#btn-baseline').classList.toggle('on', state.baselineOn);
  document.body.dataset.phase = !state.started ? 'idle' : state.loss >= 1 ? 'void' : 'halls';
}
function endRehearsal() {
  rt.endRehearsal();          // closes ea-hub for good (reload to rehearse again)
  state.hubOpen = false; state.randomRot = false;
}

$('#btn-start').onclick = async () => {
  if (state.started || !rt) return;
  $('#btn-start').disabled = true;
  // INTEGRATE (Role 3): audio must start inside this click (the browser's autoplay rule).
  if (!PHONES) try {
    // Role 3's audio.js needs Tone.js as a global (vendor/tone.js). Load it here if it's there,
    // so audio works as soon as Role 3 adds the file; if it's missing we just run silent.
    if (!window.Tone) {
      await new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'vendor/tone.js'; s.onload = resolve; s.onerror = resolve; // missing file: carry on silently
        document.head.appendChild(s);
      });
    }
    const mod = await import('./audio.js');
    audio = mod.createAudio();
    await audio.start();
  } catch (err) { console.warn('[stage] audio failed, running silent:', err); audio = null; }

  state.t0 = rt.start();      // CONTRACT: bar 0 starts at t0 = now + 2000 ms
  state.started = true;
  $('#btn-start').textContent = 'Running';
  updateButtons();
  dbg('start t0', state.t0);
};

$('#btn-rehearse').onclick = () => { endRehearsal(); updateButtons(); };
$('#btn-cut').onclick = () => { rt.cut(); state.hubOpen = false; state.randomRot = false; setLoss(1); };
$('#btn-restore').onclick = () => { rt.restore(); setLoss(0); painter.setKintsugi(false); }; // restore also resets agents' sticky flags
$('#loss').oninput = (e) => setLoss(parseFloat(e.target.value));

$('#btn-corrupt').onclick = () => {
  state.rogueOn = !state.rogueOn;
  rt.setRogue(ROGUE_TARGET, state.rogueOn);
  if (!state.rogueOn) painter.setKintsugi(false);
  updateButtons();
};
$('#btn-baseline').onclick = () => {
  state.baselineOn = !state.baselineOn;
  rt.setBaseline(state.baselineOn);
  updateButtons();
};
$('#btn-rr').onclick = () => {
  const next = !state.randomRot;
  if (rt.setRandomRotation(next)) state.randomRot = next; // returns false once the hub is closed
  updateButtons();
};
$('#btn-export').onclick = () => painter.exportPNG();
// Restart from void: wipes only the PAINTING (painter.reset). The agents, music and runtime are not
// touched, so nothing on Role 1/2/3's side is affected; the next notes start building the world again.
$('#btn-void').onclick = () => painter.reset?.();

// "View as" buttons (and clicking a badge): see the painting through one agent's eyes.
//   scene painter:   recolours everything by that agent's own mood and shows its guesses (ghosts)
//   canvas painter:  falls back to showing only that agent's strokes (solo layers)
//   p5 painter:      not supported (one shared canvas), buttons greyed out
// data-view="" means "everyone" (the normal view).
const SOLO_LAYERS = { eyeA: ['architect'], eyeB: ['weaver'], poetA: ['melodist'], poetB: ['pulse', 'melkor', 'kintsugi'] };
function setView(id) {
  if (painter.supportsPerspective) painter.setPerspective(id || null);
  else if (painter.supportsSolo) painter.setSolo(id ? SOLO_LAYERS[id] : []);
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === (id || '')));
  AGENTS.forEach((a) => $(`#badge-${a.id}`).classList.toggle('viewing', a.id === id));
}
const canView = painter.supportsPerspective || painter.supportsSolo;
document.querySelectorAll('[data-view]').forEach((btn) => {
  if (!canView) { btn.disabled = true; btn.title = 'Needs the scene painter (default) or ?painter=canvas'; }
  btn.onclick = () => setView(btn.dataset.view);
});
// Click a badge to view through that agent; click it again to go back to everyone.
AGENTS.forEach((a) => ($(`#badge-${a.id}`).onclick = () => canView && setView(painter.perspective === a.id ? null : a.id)));

// Ghosts on/off: works with both painters (they hide only the ghost layer, never the painting).
$('#btn-ghosts').onclick = () => {
  const on = !painter.ghostsVisible;
  painter.setGhostsVisible(on);
  $('#btn-ghosts').classList.toggle('on', on);
  $('#btn-ghosts').textContent = on ? 'Ghosts on' : 'Ghosts off';
};

// Keyboard shortcuts for the person driving the demo. CUSTOMISE them freely.
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === '`') { DEBUG = !DEBUG; $('#debug').hidden = !DEBUG; }
  const click = (id) => { const b = $(id); if (!b.disabled) b.click(); };
  if (k === 'g') click('#btn-ghosts');
  if (k === 'v') click('#btn-void');
  if (['1', '2', '3', '4'].includes(k)) setView(AGENTS[Number(k) - 1].id); // 1-4: view as Eye-A, Poet-A, Eye-B, Poet-B
  if (k === '0') setView(null);                                           // 0: back to everyone
  if (k === 's') click('#btn-start');
  if (k === 'c') click('#btn-cut');
  if (k === 'r') click('#btn-restore');
  if (k === 'm') click('#btn-corrupt');
  if (k === 'b') click('#btn-baseline');
  if (k === 'e') click('#btn-export');
});

// ---- Boot ------------------------------------------------------------------------
$('#debug').hidden = !DEBUG;
updateButtons();
try {
  rt = await createRuntime({ seed: SEED, ...(PHONES ? { agentHost: 'phones' } : {}) }); // spawns the 4 agent Workers and the world worker (PHONES: just the world)
  if (PHONES) {
    const show = (p) => {
      const n = Object.values(p).filter(Boolean).length;
      if (!state.started) $('#btn-start').innerHTML = `Start (${n}/4 phones)<kbd>S</kbd>`;
    };
    rt.onPresence(show);
    setTimeout(() => show(rt.presence()), 0);
  }
  rt.onTelemetry(ingest);
  $('#btn-start').disabled = false;
  $('#btn-start').innerHTML = 'Start<kbd>S</kbd>';
} catch (err) {
  // DEBUG: usually a missing data file, a syntax error in a worker, or opening the page over file://
  console.error('[stage] runtime failed to start', err);
  $('#btn-start').textContent = 'Runtime error (see console)';
}
updateButtons();
setInterval(renderMetrics, METRICS_EVERY_MS);
renderMetrics();
window.addEventListener('resize', renderThreads);

// DEBUG: everything in one place for the console.
window.EA = { state, painter, metrics: computeMetrics, ingest, setLoss, get rt() { return rt; }, get audio() { return audio; } };
