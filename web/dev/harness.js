// Dev harness for Role 2: exercises runtime.js and shows telemetry as a table.
import { createRuntime } from '../runtime.js';
import { createMetrics } from '../metrics.js';

const $ = (s) => document.querySelector(s);
const log = (...a) => {
  const el = $('#log');
  el.textContent = `${new Date().toLocaleTimeString()} ${a.join(' ')}\n` + el.textContent.slice(0, 20000);
};

const state = {};
let truth = null;
let sceneBar = null;
let rogueOn = false;
let baselineOn = false;
let randRot = false;

// ?agents=windows -> each agent in its own window (open them before Start).
const agentHost = new URLSearchParams(location.search).get('agents') === 'windows' ? 'windows' : 'workers';
const rt = await createRuntime({ seed: 0, agentHost });
log(`runtime ready (${agentHost} mode, session ${rt.session}):`, rt.agentIds.join(', '));
if (agentHost === 'windows') {
  const bar = $('#windows');
  bar.hidden = false;
  for (const id of rt.agentIds) {
    const b = document.createElement('button');
    b.id = `open-${id}`;
    b.onclick = () => rt.openAgentWindow(id);
    bar.append(b);
  }
  const paint = (p) => {
    for (const id of rt.agentIds) $(`#open-${id}`).textContent = `${p[id] ? '●' : '○'} ${id}`;
    $('#start').disabled = !rt.agentIds.every((id) => p[id]);
  };
  paint(rt.presence());
  rt.onPresence(paint);
}
for (const id of rt.agentIds) state[id] = { ctx: null, rx: 0, status: null, ghosts: 0, notes: 0 };

// The metrics panel, computed ONLY by web/metrics.js from telemetry: the same code the
// simulator uses for the slides. Role 4: this is the pattern for the Stage's panel.
const metrics = createMetrics({ rollingBars: 8 });
rt.onTelemetry((m) => metrics.ingest(m, Date.now()));
const pct = (x) => (x === null || x === undefined ? '-' : `${(100 * x).toFixed(0)}%`);
setInterval(() => {
  const s = metrics.snapshot(Date.now());
  const r = s.rolling;
  const melkor = Object.entries(s.agents).map(([id, a]) => `${id}:${a.melkor}`).join('  ');
  $('#metrics').textContent =
    `phase ${s.phase} · bar ${s.bar ?? '-'} · messages received (10 s) ${s.rxLast10s}\n` +
    `scene ${s.scene ? `${s.scene.id} truth ${s.scene.truth.mode}/${s.scene.truth.density}` : '-'}\n` +
    `rolling ${r.bars} bars: accuracy ${pct(r.accuracy)} · mode ${pct(r.mode_accuracy)} · agreement ${pct(r.agreement)} · ` +
    `consonance ${pct(r.consonance)} · ghost match ${pct(r.prediction_match)}\n` +
    `Melkor status  ${melkor}`;
}, 500);

rt.onTelemetry((m) => {
  const s = state[m.from];
  switch (m.type) {
    case 'scene':
      truth = m.truth;
      sceneBar = m.bar;
      $('#scene').textContent = `scene ${m.index} (${m.id}) @bar ${m.bar}: truth ${m.truth.mode}/${m.truth.density} — ${m.caption}`;
      break;
    case 'ctx': if (s) s.ctx = m; break;
    case 'rx': if (s) s.rx = m.count; break;
    case 'status': if (s) { s.status = m; s.ghosts = 0; } break;
    case 'ghost': if (s) s.ghosts++; break;
    case 'note': if (s) s.notes++; break;
  }
});

function render() {
  const rows = rt.agentIds.map((id) => {
    const s = state[id];
    const c = s.ctx;
    const match = c && truth && c.bar >= sceneBar ? (c.mode === truth.mode && c.density === truth.density) : null;
    const st = s.status ?? {};
    return `<tr><td>${id}${st.rogue ? ' <span class="bad">MELKOR</span>' : ''}</td>
      <td>${c ? `${c.mode}/${c.density}${c.followingLeader ? ' (leader)' : ''}` : '-'}</td>
      <td class="${match === null ? '' : match ? 'ok' : 'bad'}">${match === null ? '' : match ? '✓' : '✗'}</td>
      <td>${s.rx}</td><td class="warn">${(st.suspected ?? []).join(' ')}</td>
      <td class="bad">${(st.flagged ?? []).join(' ')}</td><td>${st.response ?? ''}</td>
      <td>${s.ghosts}</td><td>${s.notes}</td></tr>`;
  });
  $('#agents tbody').innerHTML = rows.join('');
  $('#phase').textContent = `phase: ${rt.hubOpen ? 'Halls (rehearsal, hub on)' : 'Void (no hub)'} · loss ${rt.loss}`;
}
setInterval(render, 250); // a timer, not rAF: rAF pauses in hidden panes/tabs

$('#start').onclick = () => log('start t0 =', rt.start().toFixed(1));
$('#randrot').onclick = (e) => {
  randRot = !randRot;
  if (!rt.setRandomRotation(randRot)) { randRot = false; log('random rotation needs the hub (rehearsal only)'); }
  e.target.textContent = `Random rotation: ${randRot ? 'on' : 'off'}`;
};
$('#cut').onclick = () => { rt.cut(); $('#loss').value = 1; $('#lossv').textContent = '1'; log('CUT'); };
$('#restore').onclick = () => { rt.restore(); $('#loss').value = 0; $('#lossv').textContent = '0'; log('restore'); };
$('#rogue').onclick = (e) => { rogueOn = !rogueOn; rt.setRogue('poetB', rogueOn); e.target.textContent = `Corrupt Pulse: ${rogueOn ? 'on' : 'off'}`; };
$('#baseline').onclick = (e) => { baselineOn = !baselineOn; rt.setBaseline(baselineOn); e.target.textContent = `Baseline: ${baselineOn ? 'on' : 'off'}`; };
$('#loss').oninput = (e) => { rt.setLoss(e.target.value); $('#lossv').textContent = e.target.value; };
