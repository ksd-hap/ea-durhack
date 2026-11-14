// phones-qr.js — QR codes that take each phone straight to its role. [Role 2]
// Needs vendor/qrcode.js (loaded as a global by the page) and tools/phone-server.mjs (for /ip).
//
//   import { renderJoinQRs } from './phones-qr.js';
//   await renderJoinQRs(document.querySelector('#qr'), { compact: true });

const AGENTS = [
  { id: 'eyeA', name: 'Eye-A', role: 'Architect', colour: '#d9a441' },
  { id: 'poetA', name: 'Poet-A', role: 'Melodist', colour: '#e8e2c8' },
  { id: 'eyeB', name: 'Eye-B', role: 'Weaver', colour: '#3fa59a' },
  { id: 'poetB', name: 'Poet-B', role: 'Pulse', colour: '#7b6cd9' },
];

async function loadQrLib() {
  if (globalThis.qrcode) return globalThis.qrcode;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/qrcode.js', import.meta.url).href;
    s.onload = resolve;
    s.onerror = () => reject(new Error('vendor/qrcode.js missing'));
    document.head.append(s);
  });
  return globalThis.qrcode;
}

/** The base URL phones should use: the laptop's network address, as reported by the server. */
export async function phoneBaseUrl() {
  const r = await fetch('/ip', { cache: 'no-store' });
  if (!r.ok) throw new Error('not served by tools/phone-server.mjs (no /ip)');
  const { ips, port, servingNetwork } = await r.json();
  if (!servingNetwork) throw new Error('the server is bound to this laptop only: restart it without --host');
  if (!ips.length) throw new Error('the laptop has no network address: turn on the hotspot / join the Wi-Fi');
  return { base: `http://${ips[0]}:${port}`, others: ips.slice(1).map((ip) => `http://${ip}:${port}`) };
}

export function qrSvg(text, cell = 5) {
  const qr = globalThis.qrcode(0, 'M'); // type 0 = smallest version that fits; M = 15% error correction
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}

export async function renderJoinQRs(el, { compact = false } = {}) {
  await loadQrLib();
  let base;
  let others;
  try {
    ({ base, others } = await phoneBaseUrl());
  } catch (err) {
    el.innerHTML = `<p style="color:#e66">QR codes unavailable: ${err.message}</p>`;
    return null;
  }
  // Cards size to the space they get (2x2 in a narrow window, 4 across in a wide one), but never
  // below ~120 px: smaller codes get hard to scan from a few metres away.
  const card = (title, sub, url, colour) => `
    <figure style="margin:0;text-align:center;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0">
      <div style="width:100%;max-width:${compact ? 150 : 240}px;aspect-ratio:1;background:#fff;border-radius:10px;padding:6px;box-sizing:border-box;border:3px solid ${colour}">${qrSvg(url)}</div>
      <figcaption style="font-weight:600">${title}</figcaption>
      <small style="color:#8a8698">${sub}</small>
    </figure>`;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(${compact ? 120 : 180}px,1fr));gap:14px;justify-items:center;align-items:start">
      ${AGENTS.map((a) => card(a.name, a.role, `${base}/phone.html?id=${a.id}`, a.colour)).join('')}
      ${compact ? '' : card('Phone check', 'first time only', `${base}/phone-check.html`, '#555')}
    </div>
    <p style="text-align:center;color:#8a8698;font-size:12px;margin:8px 0 0">Scan with the phone's camera, then tap to join. ${base}${others.length ? ` (also: ${others.join(', ')})` : ''}</p>`;
  for (const svg of el.querySelectorAll('svg')) { svg.style.width = '100%'; svg.style.height = '100%'; }
  return base;
}
