// agent-window.js — hosts ONE agent Worker in its own window (windows mode). [Role 2]
//
// The agent is the Worker (agent.worker.js), exactly as in single-page mode: same code, same
// channels, same isolation rule. This window's main thread only:
//   1. starts that Worker with {cmd:'init', id, seed};
//   2. relays the experimenter's fault-injection switches from 'ea-control' to it
//      (setRogue / setBaseline / resetFlags, and nothing else);
//   3. answers presence pings, and refuses to run if this agent is already open elsewhere;
//   4. displays this agent's own telemetry (display only; the Worker never reads it).
// It never touches the agent network, the hub or any sense channel. It joins the run named by
// ?session= (set by rt.openAgentWindow), so a window from an earlier run can't join this one.

import { AGENT_IDS, ROLE_OF } from './core/agent.js';
import { CHANNEL, openChannel } from './channels.js';

const RELAYED = new Set(['setRogue', 'setBaseline', 'resetFlags']);
const COLOURS = { eyeA: '#d9a441', poetA: '#e8e2c8', eyeB: '#3fa59a', poetB: '#7b6cd9' };

const $ = (s) => document.getElementById(s);
const params = new URLSearchParams(location.search);
const id = params.get('id');
const seed = Number(params.get('seed') ?? 0) || 0;
const session = params.get('session');
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function fail(msg) {
  $('state').innerHTML = `<span class="bad">${msg}</span>`;
  throw new Error(msg);
}

if (!AGENT_IDS.includes(id)) fail(`unknown agent id "${id}" (use ?id=${AGENT_IDS.join('|')})`);
if (!session) fail('no ?session= in the URL: open agent windows from the Stage (rt.openAgentWindow)');
document.title = `EÄ · ${id}`;
document.documentElement.style.setProperty('--accent', COLOURS[id]);
$('name').firstChild.textContent = `${id} `;
$('role').textContent = ROLE_OF[id];

const ctl = openChannel(CHANNEL.control, session);
let running = false;
let taken = false;
let worker = null;

ctl.onmessage = (e) => {
  const m = e.data ?? {};
  switch (m.type) {
    case 'claim': // another window wants to run this agent: tell it we already are
      if (running && m.id === id && m.nonce !== nonce) ctl.postMessage({ type: 'taken', id, nonce: m.nonce });
      break;
    case 'taken':
      if (m.nonce === nonce) taken = true;
      break;
    case 'ping':
      if (running) ctl.postMessage({ type: 'present', id });
      break;
    case 'cmd':
      if (running && m.target === id && RELAYED.has(m.cmd)) worker.postMessage({ cmd: m.cmd, on: !!m.on });
      break;
  }
};

// Claim the id. Repeat, because a freshly created channel can miss the first message.
for (let i = 0; i < 3 && !taken; i++) {
  ctl.postMessage({ type: 'claim', id, nonce });
  await new Promise((r) => setTimeout(r, 250));
}
if (taken) fail(`${id} is already running in another window. Close this one.`);

worker = new Worker(new URL('./agent.worker.js', import.meta.url), { type: 'module' });
worker.addEventListener('error', (e) => fail(`worker error: ${e.message}`));
await new Promise((resolve) => {
  worker.addEventListener('message', (e) => {
    if (e.data?.type === 'ready') resolve();
    if (e.data?.type === 'error') fail(e.data.message);
  });
  worker.postMessage({ cmd: 'init', id, seed, session });
});
running = true;
ctl.postMessage({ type: 'present', id });
addEventListener('pagehide', () => ctl.postMessage({ type: 'gone', id }));
$('state').textContent = 'ready: waiting for Start';

// Display only.
const tel = openChannel(CHANNEL.telemetry, session);
let lastNote = '';
tel.onmessage = (e) => {
  const m = e.data ?? {};
  if (m.from !== id) return;
  switch (m.type) {
    case 'started':
      $('state').textContent = 'running';
      break;
    case 'ctx':
      $('ctx').textContent = `${m.mode} · ${m.density}${m.followingLeader ? ' (following leader)' : ''}`;
      break;
    case 'rx':
      $('net').innerHTML = `heard <b>${m.count}</b>/s · dropped ${m.dropped}/s · loss ${m.loss}` + (m.loss >= 1 ? ' <span class="warn">VOID</span>' : '');
      break;
    case 'status':
      document.body.classList.toggle('melkor', !!m.rogue);
      $('flags').innerHTML = [
        m.rogue ? '<span class="bad">I AM MELKOR</span>' : '',
        m.suspected.length ? `<span class="warn">suspects ${m.suspected.join(', ')}</span>` : '',
        m.flagged.length ? `<span class="bad">flagged ${m.flagged.join(', ')}</span>` : '',
        m.response !== 'normal' ? `response: <b>${m.response}</b>` : '',
        m.baseline ? 'baseline mode' : '',
      ].filter(Boolean).join(' · ');
      break;
    case 'note':
      lastNote = `bar ${m.bar} beat ${m.beat} pitch ${m.pitch}`;
      $('note').textContent = lastNote;
      break;
  }
};
