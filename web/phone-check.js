// Phone check [Role 2]: one tap verifies everything a phone needs to host an agent.
import { connectRelay, defaultRelayUrl } from './relay-client.js';
import { now, toLocal, clockInfo } from './clock.js';
import { BEAT_MS } from './core/time.js';

const $ = (s) => document.querySelector(s);
const ua = navigator.userAgent;
const ios = ua.match(/OS (\d+)_(\d+)/);
const android = ua.match(/Android (\d+)/);
$('#device').textContent = ios ? `iPhone/iPad, iOS ${ios[1]}.${ios[2]}` : android ? `Android ${android[1]}` : 'Desktop browser';

const rows = {};
function row(key, text, state = 'wait', detail = '') {
  if (!rows[key]) {
    rows[key] = document.createElement('li');
    $('#results').append(rows[key]);
  }
  const icon = { ok: '✓', bad: '✗', wait: '…' }[state];
  rows[key].innerHTML = `<span class="ic ${state}">${icon}</span><span class="tx">${text}<small>${detail}</small></span>`;
}

function features() {
  const iosMajor = ios ? +ios[1] : null;
  row('browser', 'Browser features',
    typeof Worker === 'function' && 'WebSocket' in globalThis && ('AudioContext' in globalThis || 'webkitAudioContext' in globalThis) ? 'ok' : 'bad',
    `${iosMajor !== null && iosMajor < 15 ? 'iOS too old (need 15.4+). ' : ''}` +
    `${/CriOS|FxiOS|Instagram|FBAN|WhatsApp|Discord/.test(ua) ? 'Open this in Safari itself, not an in-app browser. ' : ''}` +
    `${'audioSession' in navigator ? 'Silent switch can be bypassed (iOS 17+).' : ios ? 'Old iOS: turn the silent switch OFF.' : ''}`);
}
features();

let audioCtx = null;
async function testAudio() {
  row('audio', 'Sound', 'wait', 'unlocking…');
  try {
    if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; // play through the silent switch
    audioCtx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    await audioCtx.resume();
    tone(587.33, 0.5, audioCtx.currentTime + 0.05, 0.25); // D5
    row('audio', 'Sound', audioCtx.state === 'running' ? 'ok' : 'bad',
      audioCtx.state === 'running' ? 'You should have heard a short tone. If not: volume up' + (ios ? ', silent switch off.' : '.') : `Audio is ${audioCtx.state}. Tap again.`);
  } catch (e) {
    row('audio', 'Sound', 'bad', String(e.message || e));
  }
}

function tone(freq, dur, at, gain = 0.15) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}

async function testRelay() {
  const url = defaultRelayUrl();
  row('relay', 'Connection to the laptop', 'wait', url);
  const relay = connectRelay(url, { label: `check ${$('#device').textContent}` });
  const t = setTimeout(() => !relay.open && row('relay', 'Connection to the laptop', 'bad',
    `Can't reach ${url}. Same Wi-Fi/hotspot as the laptop? Laptop firewall allows port ${location.port || 80}?`), 4000);
  await relay.ready;
  clearTimeout(t);
  const show = () => {
    const c = clockInfo();
    const good = c.rttMs !== null && c.rttMs < 60;
    row('relay', 'Connection to the laptop', 'ok', `connected`);
    row('clock', 'Clock in sync with the laptop', good ? 'ok' : 'wait',
      `offset ${c.offsetMs.toFixed(1)} ms, round trip ${c.rttMs?.toFixed(1)} ms${good ? '' : ' (slow network: sync may be loose)'}`);
  };
  show();
  relay.onStatus(show);
  const session = await Promise.race([relay.askSession(), new Promise((r) => setTimeout(() => r(undefined), 2000))]);
  row('session', 'Stage running on the laptop', session ? 'ok' : 'wait', session ? `session ${session}` : 'not yet: open the Stage in phones mode on the laptop');
}

async function testWorker() {
  row('worker', 'Agent engine', 'wait', 'loading agent data…');
  const w = new Worker(new URL('./phone-check.worker.js', import.meta.url), { type: 'module' });
  const res = await new Promise((resolve) => {
    w.onmessage = (e) => resolve(e.data);
    w.onerror = (e) => resolve({ ok: false, error: e.message || 'worker failed (module workers need iOS 15+)' });
    w.postMessage({ id: 'eyeB' });
  });
  w.terminate();
  row('worker', 'Agent engine', res.ok ? 'ok' : 'bad',
    res.ok ? `loaded ${res.mb} MB in ${res.loadMs} ms, one perception step ${res.stepMs.toFixed(2)} ms` : res.error);
}

// Shared beat: flashes (and optionally clicks) on every beat of the SHARED clock.
let lastBeat = -1;
function beatLoop() {
  const t = now();
  const beat = Math.floor(t / BEAT_MS);
  if (beat !== lastBeat) {
    lastBeat = beat;
    $('#beat').classList.add('on');
    setTimeout(() => $('#beat').classList.remove('on'), 120);
  }
  requestAnimationFrame(beatLoop);
}
// Clicks are scheduled ahead on the audio clock at exact shared-beat times (not "when the frame
// happens"), so phones click together even if their screens refresh at different moments.
let scheduledUpTo = 0;
function clickScheduler() {
  if (audioCtx?.state === 'running' && $('#click').checked) {
    const horizon = now() + 400;
    let next = Math.max(scheduledUpTo, Math.ceil(now() / BEAT_MS) * BEAT_MS);
    while (next < horizon) {
      const local = toLocal(next); // shared ms -> this device's performance clock
      const at = audioCtx.currentTime + (local - (performance.timeOrigin + performance.now())) / 1000;
      if (at > audioCtx.currentTime) tone(Math.floor(next / BEAT_MS) % 4 === 0 ? 1174.66 : 880, 0.06, at, 0.2);
      next += BEAT_MS;
    }
    scheduledUpTo = next;
  }
  setTimeout(clickScheduler, 100);
}

$('#go').addEventListener('click', async () => {
  $('#go').disabled = true;
  $('#go').textContent = 'Checking…';
  await testAudio(); // must run inside the tap (browsers need the gesture to unlock sound)
  await Promise.all([testRelay(), testWorker()]);
  $('#go').textContent = 'Run again';
  $('#go').disabled = false;
});
requestAnimationFrame(beatLoop);
clickScheduler();
