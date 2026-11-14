/**
 * paint.js: the EÄ painting engine (Role 4)
 * ----------------------------------------------------------------------------
 * What it does
 *   Turns NoteEvents into brushstrokes. Each agent paints on its OWN offscreen
 *   canvas (a "layer"). Every animation frame (capped at MAX_FPS) we composite
 *   the layers onto the visible canvas in painter's order.
 *
 * Performance rule from the plan
 *   Strokes are drawn ONCE onto a layer and never redrawn. The only per-frame
 *   work is drawImage() of 7 layers, and only when something changed (dirty).
 *
 * How notes reach this file
 *   stage.js calls painter.enqueueNote(note). Notes arrive one bar EARLY (agents
 *   plan bar n+1 during bar n), so we hold them in a queue and paint each one
 *   when its absolute time `note.at` comes round. Then paint and sound line up.
 *
 * Grep tags in this file
 *   CUSTOMISE: a knob worth tweaking
 *   DEBUG:     a place to look when something is off
 *   CONTRACT:  depends on the shared contract in the build plan; don't change alone
 * ----------------------------------------------------------------------------
 */

// ---- Fixed musical constants (CONTRACT: D, 72 BPM, 4/4) --------------------
export const BPM = 72;
export const BEATS_PER_BAR = 4;
export const BEAT_MS = 60000 / BPM;            // 833.3 ms
export const BAR_MS = BEAT_MS * BEATS_PER_BAR;  // 3333.3 ms

// ---- Canvas -----------------------------------------------------------------
export const CANVAS_W = 1920;
export const CANVAS_H = 1080;

// CUSTOMISE: frame cap. The plan says 30 fps. Lower it if the demo laptop struggles.
const MAX_FPS = 30;

// CUSTOMISE: bars the Melodist line takes to cross the canvas once.
// About 6 scenes x 8 bars = 48 bars, roughly 2.7 minutes. After that it wraps to the left.
export const PERFORMANCE_BARS = 48;

// CUSTOMISE: background. A warm paper colour suits watercolour washes and makes
// crimson slashes and gold seams readable.
const PAPER = '#f1ebdf';

// Painter's order (CONTRACT: Architect, Weaver, Melodist, Pulse or Melkor, then ghosts).
// Kintsugi sits right above Melkor so the gold seams cover his slashes.
export const LAYERS = ['architect', 'weaver', 'melodist', 'pulse', 'melkor', 'kintsugi', 'ghosts'];

// ---- Colour from context ------------------------------------------------------
// The hue family comes from the mode, the saturation from density (from the plan).
// CUSTOMISE: these numbers ARE the look of the piece.
export const MODE_HUE = { ionian: 42, dorian: 168, aeolian: 258 }; // gold, teal, blue-violet
export const DENSITY_SAT = { 1: 35, 2: 55, 3: 78 };
// A small per-role hue shift so four agreeing agents don't blur into one flat colour.
// Set all of these to 0 if you want agreement to look perfectly uniform.
const ROLE_HUE_SHIFT = { architect: -6, weaver: 8, melodist: 0, pulse: 14 };

// Which role each agent plays (CONTRACT: agent table on page 1).
export const ROLE_OF = { eyeA: 'architect', poetA: 'melodist', eyeB: 'weaver', poetB: 'pulse' };

// ---- Seeded randomness ----------------------------------------------------------
// The plan says to seed all brush jitter so a replay looks identical. mulberry32 is
// tiny and good enough. Never use Math.random() in this file.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth 2D value noise for the Weaver's flow field. It returns values in 0..1.
function makeNoise(seed) {
  const r = mulberry32(seed);
  const N = 256;
  const grid = new Float32Array(N * N).map(() => r());
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const g = (i, j) => grid[((j & (N - 1)) * N) + (i & (N - 1))];
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

// ---- Geometry helpers -----------------------------------------------------------
/** x position for a moment in the performance: time runs left to right, then wraps. */
export function xForTime(bar, beat) {
  const total = PERFORMANCE_BARS * BEATS_PER_BAR;
  const t = ((bar * BEATS_PER_BAR + beat) % total + total) % total;
  return (t / total) * CANVAS_W;
}
/** Map a pitch range linearly onto a vertical band (higher pitch means higher on screen). */
function yForPitch(pitch, lo, hi, yBottom, yTop) {
  const u = Math.min(1, Math.max(0, (pitch - lo) / (hi - lo)));
  return yBottom + (yTop - yBottom) * u;
}

// =============================================================================
export function createPainter(canvas, { seed = 1 } = {}) {
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const main = canvas.getContext('2d');

  // One offscreen canvas per layer. A plain <canvas> works everywhere;
  // OffscreenCanvas would also work in modern browsers.
  const layer = {};
  const g = {};       // the 2D context of each layer
  const rng = {};     // an independent seeded RNG per layer, so layers don't disturb each other
  LAYERS.forEach((name, i) => {
    const c = document.createElement('canvas');
    c.width = CANVAS_W; c.height = CANVAS_H;
    layer[name] = c;
    g[name] = c.getContext('2d');
    rng[name] = mulberry32(seed * 7919 + i * 1013);
  });
  const noise = makeNoise(seed + 99);

  // ---- State ----------------------------------------------------------------
  const agentCtx = {};          // agentId -> { mode, density }, from ctx telemetry
  let queue = [];               // notes waiting for their `at` time
  const lastMelody = {};        // agentId -> { x, y }, so the Melodist line is continuous
  const washedChords = new Set(); // "agent|chord|band" keys, so we wash once per chord
  const slashes = [];           // Melkor's recent slashes, so kintsugi can mend them
  let kintsugi = false;
  let solo = new Set();         // empty means show every layer
  let ghostsVisible = true;     // the Ghosts on/off button
  let dirty = true;             // true when the visible canvas needs recompositing
  let rafId = null, lastFrame = 0;

  // DEBUG: counters shown in the debug overlay (press ` on the Stage).
  const stats = { painted: 0, late: 0, ghosts: 0, ghostHits: 0, frames: 0, fps: 0, perLayer: {} };
  LAYERS.forEach((n) => (stats.perLayer[n] = 0));
  let fpsWindowStart = performance.now(), fpsFrames = 0;

  const nowAbs = () => performance.timeOrigin + performance.now(); // CONTRACT: absolute ms

  /** The agent's colour, from ITS OWN context (so disagreement visibly clashes). */
  function colour(agentId, alpha, lightness = 52, extraHue = 0) {
    const c = agentCtx[agentId] || { mode: 'dorian', density: 2 }; // before the first ctx arrives
    const role = ROLE_OF[agentId] || 'melodist';
    const h = (MODE_HUE[c.mode] ?? 168) + (ROLE_HUE_SHIFT[role] || 0) + extraHue;
    const s = DENSITY_SAT[c.density] ?? 55;
    return `hsla(${h}, ${s}%, ${lightness}%, ${alpha})`;
  }

  // ===========================================================================
  // BRUSHES: one function per role. Each gets the note and paints on its layer.
  // ===========================================================================

  /** Architect: wide soft washes, once per chord. Low drone notes paint land, pad notes paint sky. */
  function brushArchitect(n) {
    const ctx = g.architect, r = rng.architect;
    const isDrone = n.pitch < 48;                          // D2 drone is 38; pad is 50 to 62
    const chord = Math.floor(n.bar / 2);                   // the chord changes every 2 bars
    const key = `${n.from}|${chord}|${isDrone ? 'land' : 'sky'}`;
    if (washedChords.has(key)) return;                     // one wash per chord per band
    washedChords.add(key);
    if (washedChords.size > 500) washedChords.clear();     // keep memory flat during the soak test

    // CUSTOMISE: band positions (fractions of the height).
    const [y0, y1] = isDrone ? [0.60, 1.0] : [0.0, 0.50];
    const light = isDrone ? 38 : 68;
    const dabs = 40 + Math.floor(r() * 41);                // the plan says 40 to 80 dabs
    for (let i = 0; i < dabs; i++) {
      const x = r() * CANVAS_W;
      const y = (y0 + r() * (y1 - y0)) * CANVAS_H;
      const rad = 120 + r() * 220;
      const a = 0.03 + r() * 0.03;                         // the plan says alpha 0.03 to 0.06
      const grd = ctx.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, colour(n.from, a, light));
      grd.addColorStop(1, colour(n.from, 0, light));
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** Weaver: long horizontal glazes that drift along a slow noise flow field. */
  function brushWeaver(n) {
    const ctx = g.weaver, r = rng.weaver;
    let x = xForTime(n.bar, n.beat) - 250 + r() * 100;
    let y = yForPitch(n.pitch, 57, 69, CANVAS_H * 0.78, CANVAS_H * 0.48); // the water band
    const steps = 40 + Math.floor((n.dur || 1) * 12);    // longer notes make longer glazes
    ctx.lineCap = 'round';
    ctx.lineWidth = 18 + r() * 26;
    ctx.strokeStyle = colour(n.from, 0.05, 60);           // the plan says alpha 0.05
    ctx.beginPath(); ctx.moveTo(x, y);
    const t = n.bar * 0.05;                               // the field slowly evolves over time
    for (let i = 0; i < steps; i++) {
      // CUSTOMISE: 0.004 is the scale of the field; 0.9 is how far it bends away from horizontal.
      const ang = (noise(x * 0.004, y * 0.004 + t) - 0.5) * 0.9;
      x += Math.cos(ang) * 14;
      y += Math.sin(ang) * 14;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** Melodist: ONE continuous luminous line. x is time, y is pitch, width comes from velocity. */
  function brushMelodist(n) {
    const ctx = g.melodist;
    const x = xForTime(n.bar, n.beat);
    const y = yForPitch(n.pitch, 62, 74, CANVAS_H * 0.66, CANVAS_H * 0.24);
    const w = 2 + (n.vel ?? 0.6) * 6;
    const prev = lastMelody[n.from];
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // Join to the previous point unless we wrapped round (x jumped backwards) or the gap is huge.
    if (prev && x > prev.x && x - prev.x < CANVAS_W / 6) {
      const mx = (prev.x + x) / 2;
      const path = () => { ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.bezierCurveTo(mx, prev.y, mx, y, x, y); };
      // Two passes fake the glow: a wide soft halo, then a bright core.
      path(); ctx.lineWidth = w * 3.5; ctx.strokeStyle = colour(n.from, 0.10, 70); ctx.stroke();
      path(); ctx.lineWidth = w;       ctx.strokeStyle = colour(n.from, 0.85, 45); ctx.stroke();
    } else {
      ctx.fillStyle = colour(n.from, 0.85, 45);
      ctx.beginPath(); ctx.arc(x, y, w / 2, 0, Math.PI * 2); ctx.fill();
    }
    lastMelody[n.from] = { x, y };
  }

  /** Pulse: stipple. At density 3 it's rain (slanted streaks); otherwise stars (dots with a small glint). */
  function brushPulse(n) {
    const ctx = g.pulse, r = rng.pulse;
    const density = agentCtx[n.from]?.density ?? 2;
    const cx = xForTime(n.bar, n.beat);
    const count = 2 + Math.floor(r() * 3);
    for (let i = 0; i < count; i++) {
      const x = cx + (r() - 0.5) * 260;
      const y = r() * CANVAS_H * 0.7;
      if (density >= 3) {                       // rain
        const len = 10 + r() * 16;
        ctx.strokeStyle = colour(n.from, 0.35, 35);
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - len * 0.3, y + len); ctx.stroke();
      } else {                                  // stars
        const rad = 1 + r() * 2.2;
        ctx.fillStyle = colour(n.from, 0.6, 32);
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
        if (r() < 0.25) {                       // an occasional glint cross
          ctx.strokeStyle = colour(n.from, 0.3, 32); ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke();
        }
      }
    }
  }

  /** Melkor: dark crimson palette-knife slashes. Any note with rogue: true goes here. */
  function brushMelkor(n) {
    const ctx = g.melkor, r = rng.melkor;
    const cx = xForTime(n.bar, n.beat) + (r() - 0.5) * 300;
    const cy = (0.15 + r() * 0.7) * CANVAS_H;
    const ang = -0.4 - r() * 0.6;                 // slanting up to the right
    const len = 120 + r() * 160;
    const wid = 10 + r() * 14;
    const dx = Math.cos(ang) * len / 2, dy = Math.sin(ang) * len / 2;
    const nx = -Math.sin(ang), ny = Math.cos(ang); // the perpendicular, used for thickness
    const x1 = cx - dx, y1 = cy - dy, x2 = cx + dx, y2 = cy + dy;
    // A tapered quad: thick at the start and a point at the end, like a knife stroke.
    ctx.fillStyle = `rgba(105, 8, 22, ${0.65 + r() * 0.2})`; // CUSTOMISE: Melkor's crimson
    ctx.beginPath();
    ctx.moveTo(x1 + nx * wid, y1 + ny * wid);
    ctx.lineTo(x2 + nx * 1.5, y2 + ny * 1.5);
    ctx.lineTo(x2 - nx * 1.5, y2 - ny * 1.5);
    ctx.lineTo(x1 - nx * wid * 0.6, y1 - ny * wid * 0.6);
    ctx.closePath(); ctx.fill();
    const s = { x1, y1, x2, y2, mended: false };
    slashes.push(s);
    if (slashes.length > 24) slashes.shift();
    if (kintsugi) setTimeout(() => mend(s), BAR_MS); // mend one bar after the wound appears
  }

  /** Kintsugi: a jagged gold seam along a slash, so discord is mended rather than erased. */
  function mend(s) {
    if (s.mended) return;
    s.mended = true;
    const ctx = g.kintsugi, r = rng.kintsugi;
    const segs = 9;
    const nx = -(s.y2 - s.y1), ny = (s.x2 - s.x1);
    const nl = Math.hypot(nx, ny) || 1;
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, j = (i === 0 || i === segs) ? 0 : (r() - 0.5) * 8;
      pts.push([s.x1 + (s.x2 - s.x1) * t + nx / nl * j, s.y1 + (s.y2 - s.y1) * t + ny / nl * j]);
    }
    const stroke = (w, col) => {
      ctx.lineWidth = w; ctx.strokeStyle = col; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    };
    stroke(5, 'rgba(160, 115, 20, 0.9)');   // dark gold body
    stroke(2, 'rgba(255, 228, 140, 0.95)'); // bright highlight
    stats.perLayer.kintsugi++;
    dirty = true;
  }

  const BRUSH = { architect: brushArchitect, weaver: brushWeaver, melodist: brushMelodist, pulse: brushPulse };

  /** Paint one note now. Choose the brush by role, or Melkor if the note is rogue. */
  function paintNote(n) {
    const layerName = n.rogue ? 'melkor' : (n.role || ROLE_OF[n.from]);
    const brush = n.rogue ? brushMelkor : BRUSH[layerName];
    if (!brush) { console.warn('[paint] no brush for note', n); return; } // DEBUG: an unknown role means a contract mismatch
    brush(n);
    stats.painted++;
    stats.perLayer[layerName]++;
    dirty = true;
  }

  // ===========================================================================
  // GHOSTS: grey dashed underdrawing of what one agent PREDICTS another will play
  // ===========================================================================
  // Ghosts use a single shared mapping over the full pitch range (38 to 90), so
  // every ghost lands on one comparable grid.
  const ghostXY = (gh) => [xForTime(gh.bar, gh.beat), yForPitch(gh.pitch, 38, 90, CANVAS_H * 0.95, CANVAS_H * 0.05)];

  function drawGhost(gh) {
    const ctx = g.ghosts;
    const [x, y] = ghostXY(gh);
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(90, 90, 100, 0.55)';
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    stats.ghosts++; stats.perLayer.ghosts++;
    dirty = true;
  }
  /** The real note matched the prediction: paint over the ghost in the predicted agent's colour. */
  function ghostHit(gh) {
    const ctx = g.ghosts;
    const [x, y] = ghostXY(gh);
    ctx.fillStyle = colour(gh.about, 0.8, 45);
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    stats.ghostHits++;
    dirty = true;
  }

  // ===========================================================================
  // FRAME LOOP
  // ===========================================================================
  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    if (ts - lastFrame < 1000 / MAX_FPS - 1) return;  // the fps cap
    lastFrame = ts;

    // 1. Paint every queued note whose time has come.
    if (queue.length) {
      const now = nowAbs();
      const due = [], keep = [];
      for (const n of queue) (n.at <= now ? due : keep).push(n);
      queue = keep;
      due.sort((a, b) => a.at - b.at);
      for (const n of due) {
        if (now - n.at > BAR_MS) stats.late++;         // DEBUG: a high "late" count means notes reached us after their time
        paintNote(n);
      }
    }

    // 2. Composite, but only if something changed.
    if (dirty) {
      main.globalCompositeOperation = 'source-over';
      main.fillStyle = PAPER;
      main.fillRect(0, 0, CANVAS_W, CANVAS_H);
      for (const name of LAYERS) {
        if (solo.size && !solo.has(name)) continue;
        if (name === 'ghosts' && !ghostsVisible) continue;
        main.drawImage(layer[name], 0, 0);
      }
      dirty = false;
    }

    // 3. Measure fps for the debug overlay.
    fpsFrames++; stats.frames++;
    if (ts - fpsWindowStart > 1000) { stats.fps = fpsFrames; fpsFrames = 0; fpsWindowStart = ts; }
  }

  // ===========================================================================
  // PUBLIC API: everything stage.js is allowed to call
  // ===========================================================================
  return {
    supportsSolo: true,           // 7 separate layers, so Solo works
    start() { if (!rafId) rafId = requestAnimationFrame(frame); },
    /** Ghosts on/off without touching the rest of the painting. */
    setGhostsVisible(on) { ghostsVisible = on; dirty = true; },
    get ghostsVisible() { return ghostsVisible; },
    stop() { cancelAnimationFrame(rafId); rafId = null; },

    /** From ctx telemetry: {from, bar, mode, density}. It changes this agent's colour from now on. */
    setContext(from, mode, density) { agentCtx[from] = { mode, density }; },

    /** A NoteEvent from telemetry. It gets painted when note.at comes round. */
    enqueueNote(n) {
      if (typeof n.at !== 'number' || !isFinite(n.at)) { console.warn('[paint] note without valid at', n); return; }
      queue.push(n);
      // DEBUG: if this keeps growing, notes are arriving with `at` far in the future (clock mismatch?).
      if (queue.length > 2000) { console.warn('[paint] queue overflow, dropping oldest'); queue = queue.slice(-1000); }
    },

    drawGhost, ghostHit,

    /** Switch kintsugi on: mend the existing slashes now, and new ones one bar after they appear. */
    setKintsugi(on) {
      if (on && !kintsugi) slashes.forEach((s) => setTimeout(() => mend(s), 300 + rng.kintsugi() * 900)); // staggered, so the seams appear one by one
      kintsugi = on;
    },
    get kintsugi() { return kintsugi; },

    /** Solo: pass a list of layer names, or [] to show everything. */
    setSolo(names) { solo = new Set(names); dirty = true; },
    get solo() { return [...solo]; },

    /** Download the current painting as a PNG. */
    exportPNG(filename = `ea-painting-${Date.now()}.png`) {
      canvas.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }, 'image/png');
    },

    /** Wipe everything, for a fresh run or a rehearsal. */
    reset() {
      LAYERS.forEach((n) => g[n].clearRect(0, 0, CANVAS_W, CANVAS_H));
      queue = []; slashes.length = 0; washedChords.clear(); kintsugi = false;
      Object.keys(lastMelody).forEach((k) => delete lastMelody[k]);
      dirty = true;
    },

    stats: () => ({ ...stats, queued: queue.length, slashes: slashes.length }),
    layers: layer, // DEBUG: window.EA.painter.layers.melodist lets you inspect one layer
  };
}
