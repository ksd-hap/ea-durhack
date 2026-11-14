// clock.js — the one time base every device agrees on. [Role 2]
//
// On one laptop it is just performance.timeOrigin + performance.now() (offset 0). With phones,
// relay-client.js measures this device's offset to the laptop's clock (NTP-style: the reply with
// the smallest round trip wins) and sets it here, so bars line up across devices to within a few
// milliseconds. Every scheduling decision (bar timing, note times, t0) uses now() from here.

let offsetMs = 0;
let rttMs = null;

export function now() {
  return performance.timeOrigin + performance.now() + offsetMs;
}

/** Local (unsynced) absolute ms, e.g. for converting a shared time to this device's audio clock. */
export function localNow() {
  return performance.timeOrigin + performance.now();
}

export function setOffset(ms, rtt = null) {
  offsetMs = ms;
  rttMs = rtt;
}

export function clockInfo() {
  return { offsetMs, rttMs };
}

/** Shared time -> this device's local performance-based time (for Web Audio scheduling). */
export function toLocal(sharedMs) {
  return sharedMs - offsetMs;
}
