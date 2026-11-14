/**
 * paint-scene.js: the EÄ "living landscape" painter (Role 4). THE DEFAULT.
 * ----------------------------------------------------------------------------
 * DIFFERENT IDEA FROM paint-p5.js
 *   paint-p5.js piles up brush strokes, so it starts empty and gets messy.
 *   This file REDRAWS the whole scene every frame from a small amount of state,
 *   so it looks finished from the first second and the music keeps CHANGING it:
 *
 *     Architect (Eye-A)  → sky colours, the moon's glow, the far mountains
 *     Melodist  (Poet-A) → the bright jagged ridge at the horizon: it IS the melody,
 *                          one point per note, scrolling left as time passes
 *     Weaver    (Eye-B)  → clouds (long notes) and ripples on the water (short notes)
 *     Pulse     (Poet-B) → stars flaring, fireflies over the water, rain when busy
 *     Melkor             → red cracks that spread from outbreak points anywhere
 *     Kintsugi           → gold runs along the cracks, then the red fades to a gold scar
 *
 *   Everything above the horizon is mirrored into the lake as a reflection.
 *
 * SEEING WHO DOES WHAT
 *   - Every note makes a short glowing ring where it landed, in that agent's colour.
 *   - The legend (top-left) lists each agent, its colour and what it paints; a row
 *     lights up while that agent is playing.
 *
 * SEEING THROUGH ONE AGENT'S EYES (setPerspective, the "View as" buttons)
 *   - The whole scene is coloured by THAT agent's own mood reading, so you see the world
 *     as it believes it is. Compare views: if they look the same, the agents agree.
 *   - Its predictions (ghosts) of the Melodist are drawn as a dashed line ahead of "now",
 *     and stay behind it, so you can see how well its guesses matched the real ridge.
 *   - The banner at the top says how many of its guesses came true.
 *
 * Plain Canvas 2D: no libraries, nothing to download. Same API as paint.js and paint-p5.js.
 * Grep tags: CUSTOMISE (a knob) / DEBUG (look here when broken)
 * ----------------------------------------------------------------------------
 */
import { BAR_MS, BEAT_MS, CANVAS_W as W, CANVAS_H as H, MODE_HUE, DENSITY_SAT, mulberry32 } from './paint.js';
import { RIDGE, HILL_TOP, SHORE_TOP, SUN, smoothLine, ridgeY } from './composition.js';

// =============================================================================
// KNOBS
// =============================================================================
const HORIZON = 720;              // CUSTOMISE: y where land meets water (and the reflection starts)
const NOW_X = W * 0.86;           // CUSTOMISE: where "now" sits on the melody ridge; the right of it is the future
const PX_PER_BEAT = 12;           // CUSTOMISE: how fast the melody ridge scrolls (px per beat)
const MEL_BASE = 700;             // CUSTOMISE: ridge height for the lowest note (y)
const MEL_PX_PER_SEMITONE = 13;   // CUSTOMISE: how tall each step up in pitch makes the ridge
const FPS = 30;                   // CUSTOMISE: frame cap
const STAR_COUNT = 170;           // CUSTOMISE: background stars
const PULSE_LIFE_MS = 1100;       // CUSTOMISE: how long the "a note landed here" ring lasts
const SHOW_LEGEND = true;         // CUSTOMISE: the who-paints-what box, top-left
// ---- The reveal: the painting is "painted in" strip by strip, left to right, as the music plays.
// Before a strip is reached you see only a faint pencil sketch of the landscape on dark paper.
const REVEAL = true;              // CUSTOMISE: false = show the whole living scene at once
const STRIP_FRAC = 0.08;          // CUSTOMISE: width of each strip, as a share of the canvas (0.05 to 0.10)
const STRIPS_PER_BAR = 1;         // CUSTOMISE: strips revealed per bar (1 bar = 3.3 s; 13 strips ≈ 40 s to fill)
const REVEAL_EASE = 0.06;         // CUSTOMISE: how smoothly the brush edge glides to the next strip (0-1)
const PAPER = '#0d0c14';          // the unpainted canvas colour
// Melkor's cracks
const CRACK_RGB = '230, 40, 60';  // CUSTOMISE: crack red
const SEGMENTS_PER_NOTE = 3, CONTAINED_SEGMENTS = 2, ISOLATED_MULT = 2;
const CRACK_LEN = [28, 55], CRACK_TURN = 38, CRACK_JAGGED = 12, BRANCH_CHANCE = 0.22, MAX_TIPS = 10;
const NEW_SITE_EVERY = 25;        // CUSTOMISE: after this many segments, corruption breaks out somewhere NEW too
const NEW_OUTBREAK_BARS = 4, HEAL_AFTER_BARS = 4;
const MEND_STAGGER_MS = 120, MEND_LAG_MS = 2 * BAR_MS, GOLD_IN_MS = 1200, RED_FADE_MS = 10000, SCAR_ALPHA = 0.7;

// Who paints what (used by the legend, the pulses and the banner). CUSTOMISE the words freely.
export const AGENT_INFO = {
  eyeA:  { name: 'Eye-A',  role: 'Architect', paints: 'sky, moon, mountains' },
  poetA: { name: 'Poet-A', role: 'Melodist',  paints: 'the glowing ridge (its melody)' },
  eyeB:  { name: 'Eye-B',  role: 'Weaver',    paints: 'clouds, ripples on the water' },
  poetB: { name: 'Poet-B', role: 'Pulse',     paints: 'stars, fireflies, rain' },
};
const ORDER = ['eyeA', 'poetA', 'eyeB', 'poetB'];
export const MOOD_WORD = { ionian: 'bright', dorian: 'wistful', aeolian: 'dark' };
export const DENSITY_WORD = { 1: 'calm', 2: 'flowing', 3: 'busy' };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hsl = (h, s, l, a = 1) => `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;

// =============================================================================
export async function createScenePainter(canvas, { seed = 1 } = {}) {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Offscreen canvas for everything above the horizon, so it can be mirrored into the lake.
  const up = document.createElement('canvas'); up.width = W; up.height = HORIZON;
  const u = up.getContext('2d');
  // The whole finished scene is drawn here first; the reveal then copies only the painted part.
  const full = document.createElement('canvas'); full.width = W; full.height = H;
  const f = full.getContext('2d');
  let revealX = 0;                           // how far (px) the painting has been painted in
  const r = mulberry32(seed);

  // ---- State -------------------------------------------------------------------------
  const agentCtx = {};                       // agentId -> {mode, density}
  let perspective = null;                    // null = everyone's own colours; else an agentId
  let ghostsVisible = true;
  let caption = '';
  let queue = [];                            // notes waiting for their time
  let t0 = null;                             // absolute ms of bar 0, learned from the first note
  const melody = [];                         // Poet-A's notes so far: {beat, pitch, vel}
  const ghosts = [];                         // predictions: {from, about, beat, pitch, hit}
  const ghostStats = {};                     // from -> {made, hit}
  const clouds = [];                         // {x, y, r, born, life, from}
  const ripples = [];                        // {x, y, len, born, life}
  const fireflies = [];                      // {x, y, vx, vy, born, life}
  const rain = [];                           // {x, y, born}
  const flares = [];                         // {i (star index), born}
  const pulses = [];                         // {x, y, agent, born}: "a note landed here"
  const lastActive = {};                     // agentId -> ms of its last note (legend highlight)
  let moonRed = 0;                           // 0..1, how red Melkor has stained the moon
  let architectGlow = 0;                     // 0..1, a breath of light on each Architect chord
  const stats = { painted: 0, late: 0, ghosts: 0, ghostHits: 0, frames: 0, fps: 0, perLayer: {} };
  ['architect', 'weaver', 'melodist', 'pulse', 'melkor', 'kintsugi', 'ghosts'].forEach((n) => (stats.perLayer[n] = 0));
  const now = () => performance.now();
  const nowAbs = () => performance.timeOrigin + performance.now();
  const nowBeat = () => (t0 == null ? 0 : (nowAbs() - t0) / BEAT_MS);

  // Fixed, seeded scenery so the painting looks complete before any note arrives.
  const stars = Array.from({ length: STAR_COUNT }, () => {
    const x = r() * W;
    return { x, y: 20 + r() * Math.max(30, ridgeY(x) - 60), s: 0.6 + r() * 1.6, ph: r() * 6.28 };
  });
  const grass = Array.from({ length: 260 }, () => ({ x: r() * W, h: 8 + r() * 26, lean: (r() - 0.5) * 8 }));
  const shore = smoothLine(SHORE_TOP);
  const hills = smoothLine(HILL_TOP);
  for (let i = 0; i < 5; i++) clouds.push({ x: r() * W, y: 70 + r() * 150, r: 70 + r() * 70, born: -1e9, life: Infinity, from: 'eyeB' });
  for (let i = 0; i < 40; i++) ripples.push({ x: r() * W, y: HORIZON + 30 + r() * 220, len: 20 + r() * 50, born: -1e9, life: Infinity });

  // ---- Colour: an agent's mood, or the viewed agent's mood in "View as" mode ----------------
  /** The hue/saturation an agent's element is drawn in. In a perspective view, EVERYTHING uses the viewer's mood. */
  function tone(agentId) {
    const c = agentCtx[perspective || agentId] || { mode: 'dorian', density: 2 };
    return { h: MODE_HUE[c.mode] ?? 168, s: Math.min(100, (DENSITY_SAT[c.density] ?? 55) + 20), density: c.density };
  }
  const agentColour = (id, l = 60, a = 1) => { const t = tone(id); return hsl(t.h, t.s, l, a); };

  // ---- Melody mapping (shared by the ridge and the Melodist ghosts) --------------------------
  const melX = (beat) => NOW_X - (nowBeat() - beat) * PX_PER_BEAT;
  const melY = (pitch) => clamp(MEL_BASE - (pitch - 60) * MEL_PX_PER_SEMITONE, 430, MEL_BASE + 10);

  // ===========================================================================
  // NOTES → STATE CHANGES (nothing is drawn here; the frame loop draws state)
  // ===========================================================================
  function pulseAt(x, y, agent) { pulses.push({ x, y, agent, born: now() }); if (pulses.length > 80) pulses.shift(); }

  function onNote(n) {
    const beat = n.bar * 4 + n.beat;
    lastActive[n.rogue ? 'melkor' : n.from] = now();
    if (n.rogue) { stats.perLayer.melkor++; return melkorNote(n); }
    switch (n.from) {
      case 'eyeA': {                                   // Architect: the sky breathes, mountains catch the light
        architectGlow = 1;
        stats.perLayer.architect++;
        pulseAt(200 + r() * (W - 400), ridgeY(W / 2) - 60 - r() * 200, 'eyeA');
        break;
      }
      case 'poetA': {                                  // Melodist: one more point on the ridge
        melody.push({ beat, pitch: n.pitch, vel: n.vel ?? 0.6 });
        if (melody.length > 400) melody.shift();
        stats.perLayer.melodist++;
        pulseAt(melX(beat), melY(n.pitch), 'poetA');
        break;
      }
      case 'eyeB': {                                   // Weaver: long notes = clouds, short = ripples
        stats.perLayer.weaver++;
        if ((n.dur || 1) >= 2) {
          const c = { x: -100 + r() * (W * 0.9), y: 60 + r() * 170, r: 60 + r() * 80, born: now(), life: 60000, from: 'eyeB' };
          clouds.push(c); if (clouds.length > 16) clouds.splice(5, 1);  // keep the 5 base clouds
          pulseAt(c.x, c.y, 'eyeB');
        } else {
          const rp = { x: r() * W, y: HORIZON + 25 + r() * 230, len: 30 + r() * 70, born: now(), life: 6000 };
          ripples.push(rp); if (ripples.length > 140) ripples.splice(40, 1); // keep the 40 base ripples
          pulseAt(rp.x, rp.y, 'eyeB');
        }
        break;
      }
      case 'poetB': {                                  // Pulse: a star flares and a firefly is born
        stats.perLayer.pulse++;
        const i = Math.floor(r() * stars.length);
        flares.push({ i, born: now() }); if (flares.length > 40) flares.shift();
        fireflies.push({ x: r() * W, y: HORIZON + 20 + r() * 260, vx: (r() - 0.5) * 0.6, vy: (r() - 0.5) * 0.3, born: now(), life: 7000 });
        if (fireflies.length > 50) fireflies.shift();
        if (tone('poetB').density >= 3) for (let k = 0; k < 6; k++) rain.push({ x: r() * W, y: r() * HORIZON, born: now() });
        if (rain.length > 300) rain.splice(0, rain.length - 300);
        pulseAt(stars[i].x, stars[i].y, 'poetB');
        break;
      }
    }
    stats.painted++;
  }

  // ===========================================================================
  // MELKOR: cracks from outbreak points ANYWHERE in the landscape, plus new sites as it goes on
  // ===========================================================================
  const cracks = [];
  let outbreaks = [];               // [{ox, oy, tips: [{x, y, gen}]}]
  let lastRogueBar = -Infinity, lastRogueAt = -Infinity, segsSinceSite = 0;
  let kintsugi = false, isolated = false;

  function newSite() {
    // CUSTOMISE: where corruption can break out. Now: anywhere except the very edges.
    const ox = 200 + r() * (W - 400), oy = 140 + r() * (H - 300);
    outbreaks.push({ ox, oy, tips: [{ x: ox, y: oy, gen: 0 }] });
    if (outbreaks.length > 4) outbreaks.shift();
    segsSinceSite = 0;
  }
  function growCrack() {
    const ob = outbreaks[Math.floor(r() * outbreaks.length)];
    const ti = Math.floor(r() * ob.tips.length), tip = ob.tips[ti];
    const away = tip.gen === 0 ? r() * 6.283 : Math.atan2(tip.y - ob.oy, tip.x - ob.ox);
    let ang = away + (r() - 0.5) * 2 * (CRACK_TURN * Math.PI / 180);
    const len = CRACK_LEN[0] + r() * (CRACK_LEN[1] - CRACK_LEN[0]), M = 20;
    const out = (a) => { const x = tip.x + Math.cos(a) * len, y = tip.y + Math.sin(a) * len; return x < M || x > W - M || y < M || y > H - M; };
    if (out(ang)) ang = Math.atan2(H / 2 - tip.y, W / 2 - tip.x) + (r() - 0.5) * 2;   // edge: turn back inwards
    const x2 = clamp(tip.x + Math.cos(ang) * len, M, W - M), y2 = clamp(tip.y + Math.sin(ang) * len, M, H - M);
    const nx = -(y2 - tip.y) / len, ny = (x2 - tip.x) / len;
    const seam = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6, j = k === 0 || k === 6 ? 0 : (r() - 0.5) * CRACK_JAGGED;
      seam.push([tip.x + (x2 - tip.x) * t + nx * j, tip.y + (y2 - tip.y) * t + ny * j]);
    }
    const gen = tip.gen + 1;
    cracks.push({ seam, nx, ny, w: Math.max(1.3, 5 - gen * 0.3), strands: [(r() - 0.5) * 3, (r() - 0.5) * 4, (r() - 0.5) * 5],
      x2, y2, stain: r() < 0.3 ? 10 + r() * 16 : 0, mendAt: null });
    if (cracks.length > 600) cracks.shift();
    const next = { x: x2, y: y2, gen };
    if (r() < BRANCH_CHANCE) ob.tips.push(next); else ob.tips[ti] = next;
    if (ob.tips.length > MAX_TIPS) ob.tips.shift();
    segsSinceSite++;
  }
  function melkorNote(n) {
    lastRogueAt = now();
    if (!outbreaks.length || n.bar - lastRogueBar > NEW_OUTBREAK_BARS) { outbreaks = []; newSite(); }
    lastRogueBar = n.bar;
    if (segsSinceSite >= NEW_SITE_EVERY) newSite();   // corruption also breaks out somewhere new
    const grow = isolated ? SEGMENTS_PER_NOTE * ISOLATED_MULT : kintsugi ? CONTAINED_SEGMENTS : SEGMENTS_PER_NOTE;
    for (let i = 0; i < grow; i++) growCrack();
    if (kintsugi && !isolated) cracks.slice(-grow).forEach((c, i) => (c.mendAt = now() + MEND_LAG_MS + i * MEND_STAGGER_MS));
    moonRed = Math.min(1, moonRed + 0.06);
    const last = cracks.at(-1);
    pulsePlace(last);
  }
  function pulsePlace(c) { if (c) pulseAt(c.x2, c.y2, 'melkor'); }
  function scheduleMend() {
    let k = 0;
    for (const c of cracks) if (c.mendAt == null) c.mendAt = now() + 300 + k++ * MEND_STAGGER_MS;
  }

  // ===========================================================================
  // DRAWING, one frame
  // ===========================================================================
  function drawSky(g) {
    const a = tone('eyeA');
    const glow = 0.85 + architectGlow * 0.15;
    const grd = g.createLinearGradient(0, 0, 0, HORIZON);
    grd.addColorStop(0, hsl(a.h + 200, 45, 7));             // deep night at the top
    grd.addColorStop(0.55, hsl(a.h + 230, 50, 22 * glow));
    grd.addColorStop(1, hsl(a.h, a.s, 45 * glow));          // the mood's colour glows at the horizon
    g.fillStyle = grd; g.fillRect(0, 0, W, HORIZON);
    // Three soft glows along the horizon, all in the Architect's palette (an aurora feel).
    [[0.18, -40], [0.52, 25], [0.84, -70]].forEach(([fx, dh], i) => {
      const x = W * fx, y = HORIZON - 160 - i * 30, rad = 520;
      const rg = g.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, hsl(a.h + dh, a.s, 55, 0.35 * glow)); rg.addColorStop(1, hsl(a.h + dh, a.s, 55, 0));
      g.fillStyle = rg; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    });
  }
  function drawStars(g, t) {
    for (const s of stars) {
      const tw = 0.55 + 0.45 * Math.sin(t / 700 + s.ph);
      g.fillStyle = `rgba(255,255,255,${0.35 + 0.5 * tw})`;
      g.beginPath(); g.arc(s.x, s.y, s.s, 0, 6.283); g.fill();
    }
    for (const f of flares) {                               // Pulse: a star flares in Pulse's colour
      const age = (t - f.born) / 1600; if (age > 1) continue;
      const s = stars[f.i], rad = 4 + 18 * (1 - age);
      const rg = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, rad);
      rg.addColorStop(0, agentColour('poetB', 85, 0.95 * (1 - age))); rg.addColorStop(1, agentColour('poetB', 70, 0));
      g.fillStyle = rg; g.beginPath(); g.arc(s.x, s.y, rad, 0, 6.283); g.fill();
    }
  }
  function drawMoon(g) {
    const { x, y, r: rad } = SUN;
    const a = tone('eyeA');
    const halo = g.createRadialGradient(x, y, rad * 0.6, x, y, rad * 2.6);
    halo.addColorStop(0, hsl(a.h + 20, 60, 80, 0.35)); halo.addColorStop(1, hsl(a.h + 20, 60, 80, 0));
    g.fillStyle = halo; g.beginPath(); g.arc(x, y, rad * 2.6, 0, 6.283); g.fill();
    g.fillStyle = hsl(a.h + 30, 30, 88); g.beginPath(); g.arc(x, y, rad, 0, 6.283); g.fill();
    if (moonRed > 0.01) { g.fillStyle = `rgba(200, 20, 40, ${0.75 * moonRed})`; g.beginPath(); g.arc(x, y, rad, 0, 6.283); g.fill(); }
  }
  function drawClouds(g, t) {
    for (const c of clouds) {
      const age = t - c.born; if (age > c.life) continue;
      const fade = Math.min(1, age / 3000) * (c.life === Infinity ? 1 : Math.min(1, (c.life - age) / 8000));
      const x = ((c.x + t * 0.008) % (W + 400)) - 200;      // drift slowly to the right, wrap round
      const col = tone(c.from);
      const ch = 320 + (col.h - 168) * 0.3;               // always pink-lavender, nudged by the Weaver's mood
      for (let k = 0; k < 5; k++) {
        const px = x + (k - 2) * c.r * 0.55, py = c.y + Math.sin(k * 1.7) * c.r * 0.18, pr = c.r * (0.55 + 0.25 * Math.cos(k));
        const rg = g.createRadialGradient(px, py, 0, px, py, pr);
        rg.addColorStop(0, hsl(ch, 65, 80, 0.3 * fade)); rg.addColorStop(1, hsl(ch, 65, 80, 0));
        g.fillStyle = rg; g.beginPath(); g.arc(px, py, pr, 0, 6.283); g.fill();
      }
    }
  }
  function fillLand(g, top, bottomY, colTop, colBottom) {
    const grd = g.createLinearGradient(0, Math.min(...top.map((p) => p[1])), 0, bottomY);
    grd.addColorStop(0, colTop); grd.addColorStop(1, colBottom);
    g.fillStyle = grd; g.beginPath();
    top.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.lineTo(W + 40, bottomY); g.lineTo(-40, bottomY); g.closePath(); g.fill();
  }
  function drawMountains(g) {
    const a = tone('eyeA');
    fillLand(g, RIDGE, HORIZON + 4, hsl(a.h + 220, 30, 34), hsl(a.h + 230, 35, 18));   // far range
    fillLand(g, hills, HORIZON + 4, hsl(a.h + 235, 28, 20), hsl(a.h + 240, 30, 11));   // nearer hills
  }
  function drawMelodyRidge(g) {
    const m = tone('poetA');
    const b = nowBeat();
    // Before the melody has reached a spot, the ridge lies flat at the base (no long straight ramp).
    const notes = melody.filter((n) => n.beat <= b && melX(n.beat) > -40);
    const pts = [[-20, MEL_BASE]];
    if (notes.length) pts.push([melX(notes[0].beat) - 20, MEL_BASE]);
    for (const n of notes) pts.push([melX(n.beat), melY(n.pitch)]);
    pts.push([notes.length ? Math.min(NOW_X, pts.at(-1)[0] + 30) : NOW_X, MEL_BASE]);
    // Filled hill, in the Melodist's colour.
    const grd = g.createLinearGradient(0, 470, 0, HORIZON);
    grd.addColorStop(0, hsl(m.h, m.s, 38, 0.95)); grd.addColorStop(1, hsl(m.h, m.s, 14, 1));
    g.fillStyle = grd; g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.lineTo(pts.at(-1)[0], HORIZON + 4); g.lineTo(-20, HORIZON + 4); g.closePath(); g.fill();
    // Its glowing top edge: a wide soft pass and a bright core.
    const edge = () => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
    g.lineJoin = 'round'; g.lineCap = 'round';
    edge(); g.lineWidth = 9; g.strokeStyle = hsl(m.h, m.s, 65, 0.25); g.stroke();
    edge(); g.lineWidth = 2.5; g.strokeStyle = hsl(m.h, m.s, 82, 0.95); g.stroke();
  }
  function drawGhostPredictions(g) {
    if (!ghostsVisible) return;
    // Which agents' guesses to show: the viewed agent's, or (normal view) everyone's, faintly.
    const who = perspective ? [perspective] : ORDER;
    for (const from of who) {
      if (from === 'poetA') continue;                     // the Melodist doesn't predict itself
      const mine = ghosts.filter((gh) => gh.from === from && gh.about === 'poetA').sort((p, q) => p.beat - q.beat);
      if (!mine.length) continue;
      const alpha = perspective ? 0.9 : 0.35;
      g.setLineDash([6, 6]); g.lineWidth = perspective ? 2.5 : 1.5;
      g.strokeStyle = `rgba(255,255,255,${alpha})`;
      g.beginPath();
      mine.forEach((gh, i) => { const x = melX(gh.beat), y = melY(gh.pitch); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke(); g.setLineDash([]);
      if (!perspective) continue;                         // normal view: just the faint dashed lines, no dots
      for (const gh of mine) {                            // each guess: hollow = not (yet) right, filled = came true
        const x = melX(gh.beat), y = melY(gh.pitch);
        g.beginPath(); g.arc(x, y, gh.hit ? 6 : 5, 0, 6.283);
        if (gh.hit) { g.fillStyle = agentColour(from, 70, alpha); g.fill(); }
        else { g.strokeStyle = `rgba(255,255,255,${alpha})`; g.lineWidth = 1.5; g.stroke(); }
      }
    }
    if (perspective) {                                    // the "now" line: guesses to the right haven't happened yet
      g.strokeStyle = 'rgba(255,255,255,0.25)'; g.setLineDash([2, 6]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(NOW_X, 420); g.lineTo(NOW_X, HORIZON); g.stroke(); g.setLineDash([]);
    }
  }
  function drawRain(g, t) {
    g.strokeStyle = agentColour('poetB', 80, 0.35); g.lineWidth = 1.2;
    for (const d of rain) {
      const age = t - d.born; if (age > 1800) continue;
      const y = (d.y + age * 0.6) % H;
      g.beginPath(); g.moveTo(d.x, y); g.lineTo(d.x - 4, y + 18); g.stroke();
    }
  }
  function drawWater(g, t) {
    const w = tone('eyeB');
    // Reflection: the upper scene mirrored, squashed and dimmed.
    // Flip so the horizon row stays on the horizon and the sky lands lower down the lake.
    g.save();
    g.globalAlpha = 0.5;
    g.translate(0, HORIZON * 1.55); g.scale(1, -0.55);
    g.drawImage(up, 0, 0, W, HORIZON, 0, 0, W, HORIZON);
    g.restore();
    // Water tint: always blue, nudged by the Weaver's mood, darker towards the shore.
    const wh = 215 + (w.h - 168) * 0.25;
    const grd = g.createLinearGradient(0, HORIZON, 0, H);
    grd.addColorStop(0, hsl(wh, 45, 28, 0.45)); grd.addColorStop(1, hsl(wh + 10, 50, 8, 0.9));
    g.fillStyle = grd; g.fillRect(0, HORIZON, W, H - HORIZON);
    // Moon path on the water.
    for (let k = 0; k < 14; k++) {
      const y = HORIZON + 20 + k * 20, half = 30 + Math.sin(t / 500 + k) * 10;
      g.fillStyle = `rgba(255,240,220,${0.25 - k * 0.012})`; g.fillRect(SUN.x - half, y, half * 2, 2);
    }
    // Ripples (the Weaver's short notes), new ones brighter.
    for (const rp of ripples) {
      const age = t - rp.born; if (age > rp.life) continue;
      const fresh = rp.life === Infinity ? 0 : 1 - age / rp.life;
      const x = rp.x + Math.sin(t / 900 + rp.y) * 6;
      // A small curved wave, not a straight dash: up-and-down through two control points.
      g.strokeStyle = hsl(wh + 20, 50, 78, 0.12 + 0.55 * fresh); g.lineWidth = 1.2 + fresh;
      g.beginPath(); g.moveTo(x - rp.len / 2, rp.y);
      g.bezierCurveTo(x - rp.len / 6, rp.y - 4, x + rp.len / 6, rp.y + 4, x + rp.len / 2, rp.y); g.stroke();
    }
  }
  function drawShore(g) {
    fillLand(g, shore, H + 40, 'hsl(260, 30%, 9%)', 'hsl(260, 35%, 4%)');
    g.strokeStyle = 'hsl(150, 25%, 14%)'; g.lineWidth = 2;
    for (const b of grass) { const y = ridgeShoreY(b.x); g.beginPath(); g.moveTo(b.x, y + 2); g.quadraticCurveTo(b.x + b.lean / 2, y - b.h / 2, b.x + b.lean, y - b.h); g.stroke(); }
    // A lone tree, like the reference. CUSTOMISE: tx, ty to move it.
    const tx = 1060, ty = ridgeShoreY(1060);
    g.fillStyle = 'hsl(260, 30%, 6%)'; g.fillRect(tx - 4, ty - 70, 8, 72);
    [[0, -95, 34], [-22, -78, 26], [22, -78, 26], [0, -70, 30]].forEach(([dx, dy, rr]) => { g.beginPath(); g.arc(tx + dx, ty + dy, rr, 0, 6.283); g.fill(); });
  }
  function ridgeShoreY(x) {
    for (let i = 1; i < shore.length; i++) { const [x0, y0] = shore[i - 1], [x1, y1] = shore[i]; if (x <= x1) return y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1)); }
    return shore.at(-1)[1];
  }
  function drawFireflies(g, t) {
    for (const f of fireflies) {
      const age = t - f.born; if (age > f.life) continue;
      f.x += f.vx; f.y += f.vy;
      const a = Math.sin((age / f.life) * Math.PI) * (0.6 + 0.4 * Math.sin(t / 180 + f.x));
      const rg = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, 10);
      rg.addColorStop(0, agentColour('poetB', 75, a)); rg.addColorStop(1, agentColour('poetB', 60, 0));
      g.fillStyle = rg; g.beginPath(); g.arc(f.x, f.y, 10, 0, 6.283); g.fill();
    }
  }
  function drawCracks(g, t) {
    if (t - lastRogueAt > HEAL_AFTER_BARS * BAR_MS && cracks.some((c) => c.mendAt == null)) scheduleMend();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const c of cracks) {
      let red = 1, gold = 0;
      if (c.mendAt != null && t >= c.mendAt) {
        const tt = t - c.mendAt, fade = clamp((tt - GOLD_IN_MS) / RED_FADE_MS, 0, 1);
        gold = clamp(tt / GOLD_IN_MS, 0, 1) * (1 - (1 - SCAR_ALPHA) * fade); red = 1 - fade;
      }
      const path = (o) => { g.beginPath(); c.seam.forEach(([x, y], k) => (k ? g.lineTo(x + c.nx * o, y + c.ny * o) : g.moveTo(x + c.nx * o, y + c.ny * o))); };
      if (red > 0.01) {
        if (c.stain) { const rg = g.createRadialGradient(c.x2, c.y2, 0, c.x2, c.y2, c.stain); rg.addColorStop(0, `rgba(${CRACK_RGB},${0.4 * red})`); rg.addColorStop(1, `rgba(${CRACK_RGB},0)`); g.fillStyle = rg; g.beginPath(); g.arc(c.x2, c.y2, c.stain, 0, 6.283); g.fill(); }
        c.strands.forEach((o, i) => { path(o); g.lineWidth = c.w * (1 - i * 0.3); g.strokeStyle = `rgba(${CRACK_RGB},${red * (0.95 - i * 0.25)})`; g.stroke(); });
      }
      if (gold > 0.01) {
        path(0); g.lineWidth = c.w + 3; g.strokeStyle = `rgba(200,140,30,${gold * 0.85})`; g.stroke();
        path(0); g.lineWidth = Math.max(1.2, c.w * 0.5); g.strokeStyle = `rgba(255,228,140,${gold})`; g.stroke();
      }
    }
  }
  function drawPulses(g, t) {
    for (const p of pulses) {
      const age = (t - p.born) / PULSE_LIFE_MS; if (age > 1) continue;
      const col = p.agent === 'melkor' ? `rgba(${CRACK_RGB},` : null;
      g.lineWidth = 3 * (1 - age);
      g.strokeStyle = col ? `${col}${1 - age})` : agentColour(p.agent, 75, 1 - age);
      g.beginPath(); g.arc(p.x, p.y, 8 + 34 * age, 0, 6.283); g.stroke();
    }
  }
  function drawLegend(g, t) {
    if (!SHOW_LEGEND) return;
    const rows = ORDER.map((id) => ({ id, ...AGENT_INFO[id] }));
    const melkorOn = t - (lastActive.melkor || -1e9) < 3 * BAR_MS;
    // CUSTOMISE: LEGEND_FONT is the text size in canvas pixels (the canvas is 1920 wide, shown smaller).
    const LEGEND_FONT = 30, rowH = 46;
    const lines = rows.map((row) => `${row.name} · ${row.paints}`);
    if (melkorOn) lines.push('Melkor · red cracks (gold = mended)');
    g.font = `${LEGEND_FONT}px system-ui, sans-serif`;
    const wBox = Math.max(...lines.map((s) => g.measureText(s).width)) + 90;
    const x = 28, y = 26, hBox = 66 + lines.length * rowH;
    g.fillStyle = 'rgba(8, 8, 16, 0.6)'; roundRect(g, x, y, wBox, hBox, 16); g.fill();
    g.font = `600 ${LEGEND_FONT}px Georgia, serif`; g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillText(perspective ? `Seen through ${AGENT_INFO[perspective].name}'s eyes` : 'Who paints what', x + 22, y + 44);
    g.font = `${LEGEND_FONT}px system-ui, sans-serif`;
    lines.forEach((line, i) => {
      const id = rows[i]?.id;
      const yy = y + 66 + i * rowH + 30;
      const active = id ? t - (lastActive[id] || -1e9) < 600 : true;   // a row lights up while its agent plays
      g.fillStyle = id ? agentColour(id, active ? 72 : 58, 1) : `rgba(${CRACK_RGB},1)`;
      g.beginPath(); g.arc(x + 36, yy - 10, active ? 14 : 10, 0, 6.283); g.fill();
      g.fillStyle = id ? (active ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.72)') : 'rgba(255,200,200,0.95)';
      g.fillText(line, x + 62, yy);
    });
  }
  function drawBanner(g) {
    if (!perspective) return;
    const s = ghostStats[perspective] || { made: 0, hit: 0 };
    const pct = s.made ? Math.round((100 * s.hit) / s.made) : null;
    const txt = perspective === 'poetA'
      ? 'Poet-A plays the melody, so it makes no guesses about it. Colours = its own mood reading.'
      : `Colours = ${AGENT_INFO[perspective].name}'s mood reading · dashed line = its guesses of the melody · ${pct == null ? 'no guesses yet' : pct + '% came true'}`;
    g.font = '28px system-ui, sans-serif';
    const wTxt = Math.min(W - 40, g.measureText(txt).width + 44);
    g.fillStyle = 'rgba(8,8,16,0.75)'; roundRect(g, (W - wTxt) / 2, H - 84, wTxt, 56, 14); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)'; g.fillText(txt, (W - wTxt) / 2 + 22, H - 46, W - 80);
  }
  function drawCaption(g) {
    if (!caption || perspective) return;
    g.font = 'italic 26px Georgia, serif'; g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(`“${caption}”`, 40, H - 40);
  }
  function roundRect(g, x, y, w, h, rr) { g.beginPath(); g.moveTo(x + rr, y); g.arcTo(x + w, y, x + w, y + h, rr); g.arcTo(x + w, y + h, x, y + h, rr); g.arcTo(x, y + h, x, y, rr); g.arcTo(x, y, x + w, y, rr); g.closePath(); }

  // ---- The reveal ----------------------------------------------------------------------------
  /** A faint pencil sketch of the landscape: what an unpainted strip looks like. */
  function drawSketch(g) {
    g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.13)'; g.lineWidth = 1.6;
    const line = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); };
    line(RIDGE); line(hills); line(shore);
    g.beginPath(); g.moveTo(0, HORIZON); g.lineTo(W, HORIZON); g.stroke();
    g.beginPath(); g.arc(SUN.x, SUN.y, SUN.r, 0, 6.283); g.stroke();
  }
  /**
   * Show the scene up to revealX, with a ragged, slightly moving brush edge, over the sketch.
   * revealX glides towards (strips earned so far) x (strip width): one strip per bar of music.
   */
  function composeReveal(t) {
    const strips = t0 == null ? 0 : Math.floor((nowBeat() / 4) * STRIPS_PER_BAR) + 1;
    const target = Math.min(W + 60, strips * STRIP_FRAC * W);
    revealX += (target - revealX) * REVEAL_EASE;
    drawSketch(ctx);
    if (revealX < 2) return;
    if (revealX >= W + 50) { ctx.drawImage(full, 0, 0); return; }   // fully painted: no clipping needed
    ctx.save();
    ctx.beginPath(); ctx.moveTo(0, 0);
    for (let y = 0; y <= H; y += 24) {                                // the wet, uneven brush edge
      const wob = Math.sin(y * 0.031 + t / 600) * 14 + Math.sin(y * 0.11 + 2) * 7;
      ctx.lineTo(revealX + wob, y);
    }
    ctx.lineTo(0, H); ctx.closePath(); ctx.clip();
    ctx.drawImage(full, 0, 0);
    ctx.restore();
    // A soft glow along the edge, like fresh paint.
    const g = ctx.createLinearGradient(revealX - 40, 0, revealX + 20, 0);
    g.addColorStop(0, 'rgba(255,240,210,0)'); g.addColorStop(0.7, 'rgba(255,240,210,0.08)'); g.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = g; ctx.fillRect(revealX - 40, 0, 60, H);
  }

  // ---- Frame loop ------------------------------------------------------------------------
  let rafId = null, lastFrame = 0, fpsWin = performance.now(), fpsN = 0;
  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    if (ts - lastFrame < 1000 / FPS - 1) return;
    lastFrame = ts;
    // 1. Notes whose time has come change the state.
    if (queue.length) {
      const nowA = nowAbs(), keep = [];
      for (const n of queue) (n.at <= nowA ? (nowA - n.at > BAR_MS && stats.late++, onNote(n)) : keep.push(n));
      queue = keep;
    }
    const t = now();
    architectGlow *= 0.96; moonRed *= kintsugi ? 0.995 : 0.9995;
    // 2. Upper scene into the offscreen canvas (so it can be reflected), then onto the page.
    drawSky(u); drawStars(u, t); drawMoon(u); drawClouds(u, t); drawMountains(u); drawMelodyRidge(u);
    f.drawImage(up, 0, 0);
    drawGhostPredictions(f);
    // 3. Water with reflection, then the shore, then the moving things, all into the full scene.
    drawWater(f, t); drawShore(f); drawFireflies(f, t); drawRain(f, t);
    drawCracks(f, t);
    // 4. Show it: either all of it, or only the part painted in so far (the reveal).
    if (REVEAL) composeReveal(t); else ctx.drawImage(full, 0, 0);
    // 5. Labels and pulses always on top, so you can see who's playing even before a strip is painted.
    drawPulses(ctx, t);
    drawLegend(ctx, t); drawBanner(ctx); drawCaption(ctx);
    stats.frames++; fpsN++;
    if (ts - fpsWin > 1000) { stats.fps = fpsN; fpsN = 0; fpsWin = ts; }
  }

  // ===========================================================================
  // PUBLIC API (the same as the other painters, plus setPerspective / setCaption)
  // ===========================================================================
  return {
    supportsSolo: false,
    supportsPerspective: true,
    start() { if (!rafId) rafId = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(rafId); rafId = null; },
    setContext(from, mode, density) { agentCtx[from] = { mode, density }; },
    enqueueNote(n) {
      if (typeof n.at !== 'number' || !isFinite(n.at)) return;
      if (t0 == null) t0 = n.at - (n.bar * 4 + n.beat) * BEAT_MS;   // learn the clock from the first note
      queue.push(n);
      if (queue.length > 2000) queue = queue.slice(-1000);
    },
    /** A prediction from one agent about another's note (ghost telemetry). */
    drawGhost(gh) {
      ghosts.push({ from: gh.from, about: gh.about, beat: gh.bar * 4 + gh.beat, pitch: gh.pitch, hit: false, bar: gh.bar, raw: gh });
      if (ghosts.length > 600) ghosts.splice(0, 200);
      (ghostStats[gh.from] ??= { made: 0, hit: 0 }).made++;
      stats.ghosts++; stats.perLayer.ghosts++;
    },
    /** The real note matched a prediction: mark it as come true. */
    ghostHit(gh) {
      const beat = gh.bar * 4 + gh.beat;
      const m = ghosts.find((x) => x.from === gh.from && x.about === gh.about && x.beat === beat && !x.hit);
      if (m) m.hit = true;
      (ghostStats[gh.from] ??= { made: 0, hit: 0 }).hit++;
      stats.ghostHits++;
    },
    setGhostsVisible(on) { ghostsVisible = on; },
    get ghostsVisible() { return ghostsVisible; },
    setKintsugi(on) { if (on && !kintsugi) scheduleMend(); kintsugi = on; },
    get kintsugi() { return kintsugi; },
    setIsolated(on) { if (isolated && !on && kintsugi) scheduleMend(); isolated = on; },
    /** "View as": colour everything by one agent's mood and show its guesses. null = back to normal. */
    setPerspective(id) { perspective = id; },
    get perspective() { return perspective; },
    ghostStats: () => ghostStats,
    setCaption(text) { caption = text || ''; },
    setSolo() {}, get solo() { return []; },
    exportPNG(filename = `ea-painting-${Date.now()}.png`) {
      canvas.toBlob((blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, 'image/png');
    },
    reset() { queue = []; melody.length = 0; ghosts.length = 0; cracks.length = 0; outbreaks = []; moonRed = 0; kintsugi = false; revealX = 0; },
    stats: () => ({ ...stats, queued: queue.length, cracks: cracks.length, melody: melody.length }),
    cracks: () => cracks,
  };
}
