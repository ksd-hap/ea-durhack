// phone.js — one phone = one agent, playing its own voice. [Role 2]
//
// The agent is the same Worker as everywhere else (agent.worker.js), joining the laptop's run
// through the relay. This page's main thread only:
//   1. finds the Stage's session (announced through the relay) and offers the four roles;
//   2. on tap: unlocks sound, claims the role (refusing duplicates) and starts the Worker;
//   3. relays the experimenter's fault-injection switches (setRogue / setBaseline / resetFlags);
//   4. plays ITS OWN agent's notes (display + sound only: the Worker never reads telemetry).
// It never touches the agent network, the hub or any sense channel (isolation check).

import { AGENT_IDS, ROLE_OF } from './core/agent.js';
import { CHANNEL, openChannel, useRelay } from './channels.js';
import { connectRelay, defaultRelayUrl } from './relay-client.js';
import { toLocal, clockInfo } from './clock.js';
import { createAudio } from './audio.js'; // loaded up front: iOS unlocks sound only if it starts INSIDE the tap

const RELAYED = new Set(['setRogue', 'setBaseline', 'resetFlags']);
const COLOURS = { eyeA: '#d9a441', poetA: '#e8e2c8', eyeB: '#3fa59a', poetB: '#7b6cd9' };
const NAMES = { eyeA: 'Eye-A', poetA: 'Poet-A', eyeB: 'Eye-B', poetB: 'Poet-B' };
const SEES = { eyeA: 'the whole photo', poetA: 'caption 1', eyeB: 'a 70% crop', poetB: 'caption 2' };
const MOOD = { ionian: 'Bright', dorian: 'Neutral', aeolian: 'Dark' };
const DENSITY = { 1: 'calm', 2: 'flowing', 3: 'busy' };
const PHONE_BASS_FLOOR = 50; // phone speakers can't reproduce the Architect's low D: lift notes below D3 an octave

const $ = (s) => document.querySelector(s);
const relayUrl = defaultRelayUrl();
const relay = connectRelay(relayUrl, { label: 'phone' });
useRelay(relay);

let session = null;
let ctl = null;
let tel = null;
let myId = null;
let worker = null;
let audio = null;
let nudgeMs = 0;
try { nudgeMs = Number(localStorage.getItem('ea-nudge') || 0); } catch {}
$('#nudge').value = nudgeMs;
$('#nudgev').textContent = nudgeMs;
const taken = {}; // id -> last seen
// From a QR code: phone.html?id=eyeA shows just that role, as one big button (the tap is still
// needed: phones only unlock sound inside a tap).
const wanted = AGENT_IDS.includes(new URLSearchParams(location.search).get('id')) ? new URLSearchParams(location.search).get('id') : null;
if (wanted) {
  $('#join').style.gridTemplateColumns = '1fr';
  document.documentElement.style.setProperty('--accent', COLOURS[wanted]);
  document.querySelector('h1').textContent = `EÄ: you are ${NAMES[wanted]}`;
}

const showNet = () => {
  const c = clockInfo();
  $('#net').innerHTML = relay.open
    ? `<span class="ok">connected</span> · clock ±${(c.rttMs ?? 0).toFixed(0)} ms${session ? ` · run ${session}` : ' · waiting for the Stage'}`
    : '<span class="bad">no connection to the laptop: same Wi-Fi? reconnecting…</span>';
};
relay.onStatus(showNet);

// ---- 1. find the run, show the roles ----
async function findSession() {
  await relay.ready;
  for (;;) {
    const s = await Promise.race([relay.askSession(), new Promise((r) => setTimeout(() => r(null), 1500))]);
    if (s) return s;
    $('#net').innerHTML = '<span class="warn">waiting for the Stage: open it on the laptop with ?phones</span>';
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// Buttons are created ONCE and only updated: rebuilding them every second would delete the
// button under a finger mid-tap and swallow the tap.
const joinButtons = {};
function renderJoin() {
  const now = Date.now();
  for (const id of wanted ? [wanted] : AGENT_IDS) {
    let b = joinButtons[id];
    if (!b) {
      b = joinButtons[id] = document.createElement('button');
      b.style.borderColor = COLOURS[id];
      b.onclick = () => join(id);
      $('#join').append(b);
    }
    const isTaken = taken[id] && now - taken[id] < 3500;
    b.disabled = !!myId || isTaken;
    const label = wanted ? `Tap to join as ${NAMES[id]}` : NAMES[id];
    const html = `${label}<small>${ROLE_OF[id]} · sees ${SEES[id]}${isTaken ? '<br>already on another phone' : ''}</small>`;
    if (wanted) { b.style.padding = '34px 12px'; b.style.fontSize = '22px'; }
    if (b.innerHTML !== html) b.innerHTML = html;
  }
}

session = await findSession();
showNet();
ctl = openChannel(CHANNEL.control, session);
tel = openChannel(CHANNEL.telemetry, session);
ctl.onmessage = (e) => {
  const m = e.data ?? {};
  if (m.type === 'present' && AGENT_IDS.includes(m.id)) taken[m.id] = Date.now();
  if (m.type === 'ping' && myId && worker) ctl.postMessage({ type: 'present', id: myId });
  if (m.type === 'claim' && myId && m.id === myId) ctl.postMessage({ type: 'taken', id: myId, nonce: m.nonce });
  if (m.type === 'cmd' && myId && m.target === myId && RELAYED.has(m.cmd)) worker?.postMessage({ cmd: m.cmd, on: !!m.on });
};
ctl.postMessage({ type: 'ping' });
renderJoin();
setInterval(() => !myId && renderJoin(), 1000);

// ---- 2. join: sound first (inside the tap), then claim the role and start the agent ----
async function join(id) {
  if (myId) return;
  try {
    // Nothing may be awaited before Tone.start(): iOS only unlocks sound synchronously inside the tap.
    if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; // iOS 17+: play through the silent switch
    audio = createAudio();
    await audio.start(); // its first statement calls Tone.start(), still inside the tap
  } catch (err) {
    $('#net').innerHTML = `<span class="bad">sound blocked (${err.message}). Tap again.</span>`;
    audio = null;
    return;
  }
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let refused = false;
  const onTaken = (e) => { if (e.data?.type === 'taken' && e.data.nonce === nonce) refused = true; };
  ctl.addEventListener('message', onTaken);
  for (let i = 0; i < 3 && !refused; i++) {
    ctl.postMessage({ type: 'claim', id, nonce });
    await new Promise((r) => setTimeout(r, 250));
  }
  ctl.removeEventListener('message', onTaken);
  if (refused) { taken[id] = Date.now(); renderJoin(); $('#net').innerHTML = `<span class="bad">${NAMES[id]} is already on another phone</span>`; return; }

  myId = id;
  document.documentElement.style.setProperty('--accent', COLOURS[id]);
  $('#join').style.display = 'none';
  $('#agent').style.display = 'flex';
  $('#name').textContent = `${NAMES[id]} · ${ROLE_OF[id]}`;
  $('#state').textContent = 'starting the agent…';
  worker = new Worker(new URL('./agent.worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (e) => ($('#state').innerHTML = `<span class="bad">agent error: ${e.message}</span>`);
  await new Promise((resolve) => {
    worker.onmessage = (e) => { if (e.data?.type === 'ready') resolve(); if (e.data?.type === 'error') $('#state').innerHTML = `<span class="bad">${e.data.message}</span>`; };
    worker.postMessage({ cmd: 'init', id, seed: 0, session, relay: relayUrl });
  });
  ctl.postMessage({ type: 'present', id });
  // Heartbeat: don't wait to be pinged (a hidden Stage tab's timers get throttled to ~1/min).
  setInterval(() => ctl.postMessage({ type: 'present', id }), 1500);
  addEventListener('pagehide', () => ctl.postMessage({ type: 'gone', id }));
  $('#state').textContent = 'ready: waiting for Start on the laptop';
}

$('#nudge').oninput = (e) => {
  nudgeMs = Number(e.target.value);
  $('#nudgev').textContent = nudgeMs;
  try { localStorage.setItem('ea-nudge', String(nudgeMs)); } catch {}
};

// ---- 4. my own agent: play its voice, show its state (display + sound only) ----
tel.onmessage = (e) => {
  const m = e.data ?? {};
  if (m.type === 'scene') {
    if (myId?.startsWith('eye') && m.thumb) { $('#view').src = m.thumb; $('#view').style.display = 'block'; }
    if (myId === 'poetA') $('#caption').textContent = `“${m.caption}”`;
    return;
  }
  if (!myId || m.from !== myId) return;
  switch (m.type) {
    case 'started':
      $('#state').textContent = 'playing';
      break;
    case 'note': {
      let pitch = m.pitch;
      while (pitch < PHONE_BASS_FLOOR) pitch += 12;
      const played = audio?.onNote({ ...m, pitch, at: toLocal(m.at) + nudgeMs });
      if (played) {
        const delay = Math.max(0, toLocal(m.at) + nudgeMs - (performance.timeOrigin + performance.now()));
        setTimeout(() => { $('#orb').classList.add('hit'); setTimeout(() => $('#orb').classList.remove('hit'), 140); }, delay);
      }
      break;
    }
    case 'ctx':
      $('#mood').textContent = `${MOOD[m.mode] ?? m.mode} · ${DENSITY[m.density] ?? m.density}`;
      break;
    case 'status':
      document.body.classList.toggle('melkor', !!m.rogue);
      $('#flags').innerHTML = [
        m.rogue ? '<span class="bad">CORRUPTED: I am Melkor</span>' : '',
        m.covering ? `<span class="ok">covering the ${m.covering}'s job</span>` : '',
        m.flagged?.length ? `<span class="warn">caught: ${m.flagged.map((x) => NAMES[x]).join(', ')}</span>` : '',
        m.response === 'defend' ? 'alone: defending' : '',
      ].filter(Boolean).join(' · ');
      break;
    case 'rx':
      $('#state').textContent = m.loss >= 1 ? 'cut off: playing alone' : `hearing the others (${m.count}/s)`;
      break;
    default:
  }
};

// DEBUG: inspect from the browser console / remote inspector.
globalThis.EA_PHONE = { id: () => myId, session: () => session, audio: () => audio?.getStats?.(), clock: clockInfo };
