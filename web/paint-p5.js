/**
 * paint-p5.js: the EÄ painter, p5.js + p5.brush version (Role 4). THE DEFAULT.
 * ----------------------------------------------------------------------------
 * WHAT IT PAINTS
 *   One fixed landscape (layout in composition.js) on a dark canvas. Each agent owns
 *   parts of it and keeps repainting them, so colours follow each agent's mood:
 *
 *     Architect (Eye-A)  pad notes   → sky washes, the sun, a full-canvas tint each scene
 *                        drone notes → the LANDFORMS list (mountains, hills, shore, ...)
 *     Weaver    (Eye-B)            → lake glazes + clouds high in the sky
 *     Melodist  (Poet-A)           → a luminous line riding the mountain skyline
 *     Pulse     (Poet-B)           → stars in the sky, or rain at high density
 *     Melkor    (Pulse corrupted)  → a red CRACK that starts at one point and spreads
 *     Kintsugi                     → gold runs along the cracks from the centre outwards,
 *                                    then the red fades and the gold stays as a scar
 *     Ghosts                       → this bar's predictions, on their own layer
 *
 * THREE STACKED CANVASES (bottom to top; the CSS is in index.html, block 3a)
 *   #paint         p5.brush painting. Never cleared, but slowly faded (FADE_*), so it lives.
 *   #melkor-layer  plain 2D canvas, REDRAWN every frame from the list of cracks, so each
 *                  crack can fade its red and grow its gold independently.
 *   #ghost-layer   plain 2D canvas, wiped every bar, holding only the next bar's predictions.
 *
 * SAME API AS paint.js, so stage.js works with either painter.
 *
 * HOW A NOTE BECOMES PAINT
 *   1. stage.js calls enqueueNote(note). Notes arrive one bar early, so they wait in `queue`.
 *   2. In each p5 frame (draw()), notes whose time has come become "tasks".
 *   3. At most TASKS_PER_FRAME tasks run per frame, so a burst never freezes the page.
 *
 * Grep tags: CUSTOMISE (a knob) / DEBUG (look here when broken)
 * ----------------------------------------------------------------------------
 */
import { BAR_MS, CANVAS_W, CANVAS_H, MODE_HUE, DENSITY_SAT, ROLE_OF, mulberry32, xForTime } from './paint.js';
import { SKY_SHAPE, SUN, LANDFORMS, LAKE, CLOUDS, ridgeY } from './composition.js';

// =============================================================================
// KNOBS: the quickest things to change
// =============================================================================
// ---- Canvas and colour
const PAPER = '#0a0a10';          // CUSTOMISE: background. Light paper was '#f1ebdf' (then set LIGHT_BOOST to 0)
const LIGHT_BOOST = 15;           // CUSTOMISE: adds lightness to every agent colour, so they glow on black
const SAT_BOOST = 25;             // CUSTOMISE: adds saturation (0-100), so colours look vivid, not grey, on black
const ROLE_HUE_SHIFT = { architect: -6, weaver: 8, melodist: 0, pulse: 14 }; // four hands, even in one mood
// ---- Fading: old paint slowly sinks into the background.
// OFF by default (0), so the landscape keeps its form. Melkor no longer needs it: his cracks
// live on their own layer and fade by themselves. To try it again: FADE_ALPHA = 2, FADE_EVERY = 120.
const FADE_EVERY = 30;            // CUSTOMISE: frames between fades (30 frames = 1 second)
const FADE_ALPHA = 0;             // CUSTOMISE: strength of each fade, 0-255. 0 = never fade
// ---- Speed
const FPS = 30;                   // CUSTOMISE: frame cap (the plan says 30)
const TASKS_PER_FRAME = 10;       // CUSTOMISE: lower it if the demo laptop stutters
const BRUSH_SCALE = 8;            // CUSTOMISE: overall stroke size
// ---- Melkor's cracks
const CRACK_RGB = '208, 24, 48';  // CUSTOMISE: crack red, as "r, g, b"
const CRACK_LEN = [30, 60];       // CUSTOMISE: each new segment's length in px, [min, max]
const CRACK_JAGGED = 12;          // CUSTOMISE: how zig-zag each crack segment is, in px (0 = straight)
const CONTAINED_SEGMENTS = 2;     // CUSTOMISE: segments per rogue note once he's caught (slower, gold follows)
const ISOLATED_MULT = 2;          // CUSTOMISE: with comms CUT nobody can absorb him, so he spreads this many times faster
const SEGMENTS_PER_NOTE = 3;      // CUSTOMISE: how fast the crack spreads (segments added per rogue note).
                                  //   The agents catch Melkor in a few bars, so 3 gives a crack ~300px across.
const CRACK_TURN = 35;            // CUSTOMISE: how much each segment may bend, in degrees
const BRANCH_CHANCE = 0.2;        // CUSTOMISE: chance a segment forks (0 = a single line, 0.5 = a bush)
const MAX_TIPS = 10;              // CUSTOMISE: how many crack ends may grow at once
const NEW_OUTBREAK_BARS = 4;      // a rogue note after this many silent bars starts a NEW crack elsewhere
// ---- Kintsugi (mending)
const MEND_STAGGER_MS = 140;      // CUSTOMISE: delay between segments as gold walks outwards
const MEND_LAG_MS = 2 * 3333;     // CUSTOMISE: once Melkor is caught, each NEW crack segment turns gold this long
                                  //   after it appears (2 bars), so a red front keeps creeping with gold behind it
const GOLD_IN_MS = 1200;          // CUSTOMISE: how long gold takes to appear on one segment
const RED_FADE_MS = 10000;        // CUSTOMISE: how long the red takes to fade after the gold
const SCAR_ALPHA = 0.7;           // CUSTOMISE: how strong the gold scar stays forever (0-1)
const HEAL_AFTER_BARS = 4;        // if Melkor falls silent this long, the world mends him anyway
const GOLD_DARK = '168, 118, 26', GOLD_LIGHT = '255, 224, 138'; // CUSTOMISE: seam colours, "r, g, b"

// ---- Load the two libraries once, as classic scripts (they set window.p5 and window.brush) ----
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load ' + src)); // DEBUG: is the file in web/vendor/?
    document.head.appendChild(s);
  });
}

// ---- Colour helpers. p5.brush wants hex strings, so we convert our HSL palette ----------------
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A see-through 2D canvas the size of the painting, inserted right after `after`. */
function overlayCanvas(id, after) {
  const c = document.createElement('canvas');
  c.id = id; c.width = CANVAS_W; c.height = CANVAS_H;
  after.after(c);
  return c;
}

// =============================================================================
/** Async: resolves once p5 has made the canvas. `canvas` is the placeholder <canvas id="paint">. */
export async function createP5Painter(canvas, { seed = 1 } = {}) {
  await loadScript('vendor/p5.min.js');
  await loadScript('vendor/p5.brush.js');
  const { p5, brush } = window;
  if (!p5 || !brush) throw new Error('p5 or p5.brush missing on window'); // DEBUG

  const r = mulberry32(seed);       // our own jitter (positions, sizes), so a replay looks the same
  const agentCtx = {};              // agentId -> { mode, density }, from ctx telemetry
  let queue = [];                   // notes waiting for their time
  const tasks = [];                 // drawing jobs waiting for a frame
  const lastMelody = {};            // agentId -> [x, y], so the melody line is continuous
  const washed = new Set();         // "agent|chord|part", so the Architect washes once per chord
  let rogueNotes = 0;
  let kintsugi = false;
  let p = null, mctx = null, gctx = null, melkorCanvas = null, ghostCanvas = null;
  const stats = { painted: 0, late: 0, ghosts: 0, ghostHits: 0, frames: 0, fps: 0, tasks: 0, perLayer: {} };
  ['architect', 'weaver', 'melodist', 'pulse', 'melkor', 'kintsugi', 'ghosts'].forEach((n) => (stats.perLayer[n] = 0));
  const nowAbs = () => performance.timeOrigin + performance.now();

  /**
   * The agent's colour from ITS OWN mood, as hex. light: 0 (black) to 100 (white).
   * Hue families live in paint.js (MODE_HUE: ionian gold, dorian teal, aeolian violet).
   */
  function palette(agentId, light = 50, extraHue = 0) {
    const c = agentCtx[agentId] || { mode: 'dorian', density: 2 };
    const role = ROLE_OF[agentId] || 'melodist';
    const h = ((MODE_HUE[c.mode] ?? 168) + (ROLE_HUE_SHIFT[role] || 0) + extraHue + 360) % 360;
    return hslToHex(h, Math.min(100, (DENSITY_SAT[c.density] ?? 55) + SAT_BOOST), Math.min(92, light + LIGHT_BOOST));
  }
  /**
   * A landform's colour: the agent's mood hue pulled towards the landform's `tint` by `mix`,
   * at the landform's own saturation. So the mood still tints the land, but it reads as a
   * calm dusk silhouette instead of a flat bright slab. All values come from LANDFORMS.
   */
  function landColour(agentId, land, extraLight = 0) {
    const c = agentCtx[agentId] || { mode: 'dorian', density: 2 };
    const moodHue = MODE_HUE[c.mode] ?? 168;
    const tint = land.tint ?? moodHue, mix = land.mix ?? 0;
    const d = ((tint - moodHue + 540) % 360) - 180;          // shortest way round the colour wheel
    const h = (moodHue + d * mix + 360) % 360;
    return hslToHex(h, land.sat ?? 40, Math.min(92, land.light + extraLight + LIGHT_BOOST));
  }
  const once = (key) => { if (washed.has(key)) return false; washed.add(key); if (washed.size > 600) washed.clear(); return true; };
  /** A watercolour fill for the next shape. opacity 0-255 (low = transparent, so layers build up). */
  function watercolour(hex, opacity, bleed = 0.2, grain = 0.5, edges = 0.3) {
    brush.noStroke(); brush.noHatch(); brush.noField();
    brush.fill(hex, opacity);
    brush.fillBleed(bleed, 'out');
    brush.fillTexture(grain, edges);
  }

  // ===========================================================================
  // BRUSHES: one per role. To change how an agent paints, edit ITS function.
  // ===========================================================================

  /**
   * ARCHITECT: on its FIRST note of each chord (every 2 bars) it washes the sky, repaints the sun
   * once per scene, and paints ONE landform, cycling through LANDFORMS (composition.js).
   * Any Architect note triggers it, whatever its pitch. (It used to wait for low drone notes,
   * but the current music never plays them, so the land was never painted.)
   */
  function brushArchitect(n) {
    const chord = Math.floor(n.bar / 2);            // the chord changes every 2 bars
    if (once(`${n.from}|${chord}|sky`)) {
      // Once per scene (every 4th chord): a very faint tint over the WHOLE canvas in the current
      // mood, so every corner gets some colour. Kept faint so it doesn't grey out the land.
      if (chord % 4 === 0) {
        watercolour(palette(n.from, 30), 10, 0.1, 0.3, 0.1);  // CUSTOMISE: 10 = whole-canvas tint strength
        brush.rect(0, 0, CANVAS_W, CANVAS_H);
      }
      // Wash the whole sky in one piece. SKY_SHAPE stops at the mountain ridge, so the sky never
      // paints over the mountains, and there are no straight edges inside the canvas.
      watercolour(palette(n.from, 55), 40, 0.3, 0.45, 0.2);   // CUSTOMISE: 40 = sky opacity per chord
      brush.polygon(SKY_SHAPE);
      // The sun goes on AFTER the sky, so the sky never covers it. Repainted once per scene.
      if (chord % 4 === 0) {
        watercolour(palette(n.from, 62, -10), 90, 0.15, 0.4, 0.5);
        brush.circle(SUN.x, SUN.y, SUN.r, 0.3);
      }
    }
    if (once(`${n.from}|${chord}|land`)) {
      const i = chord % LANDFORMS.length;
      const land = LANDFORMS[i];
      const col = landColour(n.from, land);
      // 1. A solid body (a flat "wash"), so each landform reads as a coloured silhouette on black.
      //    On a dark canvas, watercolour alone only shows its bright edges, which looked empty.
      //    Water is less solid, so the Weaver's ripples keep showing through it.
      brush.noStroke(); brush.noFill(); brush.noHatch(); brush.noField();
      brush.wash(col, land.name === 'water' ? 110 : 150);   // CUSTOMISE: body opacity, 0-255 (lower = blends more)
      brush.polygon(land.points);
      brush.noWash();
      // 2. A light watercolour pass in a brighter shade on top, for texture and soft edges.
      watercolour(landColour(n.from, land, 8), 35, 0.12, 0.6, 0.35); // CUSTOMISE: 35 = texture strength
      brush.polygon(land.points);
    }
    brush.noFill();
  }

  /** WEAVER: short notes glaze the lake (the calm spotty water); long notes (2+ beats) drift as clouds high in the sky. */
  function brushWeaver(n) {
    const x = xForTime(n.bar, n.beat) - 220 + r() * 120;
    const cloud = (n.dur || 1) >= 2;
    const band = cloud ? CLOUDS : LAKE;            // band positions live in composition.js
    const u = clamp((n.pitch - 57) / 12, 0, 1);    // higher pitch sits higher in its band
    const y = band.y1 - u * (band.y1 - band.y0);
    brush.noFill();
    brush.field(cloud ? 'curved' : 'waves');       // CUSTOMISE: try 'seabed' for the lake
    brush.set(cloud ? 'spray' : 'pastel', palette(n.from, cloud ? 70 : 50), cloud ? 2.2 : 1.4); // CUSTOMISE: clouds = spray, lake = pastel
    brush.flowLine(x, y, 260 + (n.dur || 1) * 90, 0); // 0 degrees = rightwards
    brush.noField();
  }

  /** Where the Melodist's line sits for a pitch at x. Ghosts about the Melodist use it too. */
  const melodyY = (x, pitch) => ridgeY(x) - 30 - (pitch - 62) * 9; // CUSTOMISE: 30 = gap above ridge, 9 = px per semitone

  /** MELODIST: one continuous luminous line riding just above the mountain skyline. */
  function brushMelodist(n) {
    const x = xForTime(n.bar, n.beat);
    const y = melodyY(x, n.pitch);
    const prev = lastMelody[n.from];
    const w = 0.9 + (n.vel ?? 0.6) * 1.4;           // louder notes, thicker line
    if (prev && x > prev[0] && x - prev[0] < CANVAS_W / 6) {
      const mid = [(prev[0] + x) / 2, (prev[1] + y) / 2 - 6];
      brush.set('marker', palette(n.from, 45), w);  // the body of the line
      brush.spline([prev, mid, [x, y]], 0.6);
      brush.set('pen', palette(n.from, 80), w * 0.4); // a bright core makes it glow
      brush.spline([prev, mid, [x, y]], 0.6);
    }
    lastMelody[n.from] = [x, y];
  }

  /** PULSE: stars in the sky at density 1 or 2; rain across the scene at density 3. */
  function brushPulse(n) {
    const density = agentCtx[n.from]?.density ?? 2;
    const cx = xForTime(n.bar, n.beat);
    const count = 2 + Math.floor(r() * 3);
    for (let i = 0; i < count; i++) {
      const x = cx + (r() - 0.5) * 300;
      if (density >= 3) {
        const y = r() * (LAKE.y1 - 40), len = 18 + r() * 20;
        brush.set('2H', palette(n.from, 55), 1);    // CUSTOMISE: rain brush
        brush.line(x, y, x - len * 0.25, y + len);
      } else {
        const y = 30 + r() * Math.max(20, ridgeY(x) - 90); // only above the mountains
        brush.set('pen', palette(n.from, 75), 0.5 + r() * 0.9); // CUSTOMISE: star brush
        brush.line(x, y, x + 1.5, y + 1.5);         // a tiny line reads as a dot
      }
    }
  }

  // ===========================================================================
  // MELKOR: a crack that starts at one point and spreads outwards
  // ===========================================================================
  // Each rogue note adds ONE segment to the crack. A segment starts at one of the
  // crack's growing ends ("tips") and heads AWAY from the outbreak point, bending a
  // little, so the damage creeps outwards instead of appearing everywhere at once.
  // Nothing is drawn here: segments go into `cracks`, and redrawMelkor() draws them
  // each frame, which is what lets red fade and gold appear per segment.
  const cracks = [];      // segments in the order they grew: {x1,y1,x2,y2,w,strands,seam,stain,mendAt}
  let outbreak = null;    // { ox, oy, tips: [{x, y, gen}], lastBar }
  let lastRogueAt = -Infinity;
  let melkorDirty = false, melkorAnimating = false;
  let isolated = false;   // true while comms are cut (stage.js calls setIsolated from the loss slider / Cut)

  function startOutbreak(bar) {
    // CUSTOMISE: where outbreaks start. Now: anywhere in the sky (Pulse's starry part of the world).
    // Kept away from the edges (x 300-1620, mid-sky), so the crack has room to spread in every direction.
    const ox = 300 + r() * 1320;
    const oy = 200 + r() * Math.max(30, ridgeY(ox) - 260);
    outbreak = { ox, oy, tips: [{ x: ox, y: oy, gen: 0 }], lastBar: bar };
  }

  function growCrack() {
    const i = Math.floor(r() * outbreak.tips.length);
    const tip = outbreak.tips[i];
    // Head away from the outbreak point (from the point itself: any direction), then bend a little.
    const away = tip.gen === 0 ? r() * 360 : (Math.atan2(tip.y - outbreak.oy, tip.x - outbreak.ox) * 180) / Math.PI;
    let ang = ((away + (r() - 0.5) * 2 * CRACK_TURN) * Math.PI) / 180;
    const len = CRACK_LEN[0] + r() * (CRACK_LEN[1] - CRACK_LEN[0]);
    // Hitting the canvas edge used to pin a tip there forever (zero-length segments), which is why the
    // crack seemed to spread and then stop. Now a tip that would leave the canvas turns back inwards.
    const M = 20; // margin in px
    const outside = (a) => { const x = tip.x + Math.cos(a) * len, y = tip.y + Math.sin(a) * len; return x < M || x > CANVAS_W - M || y < M || y > CANVAS_H - M; };
    if (outside(ang)) {
      const toCentre = Math.atan2(CANVAS_H / 2 - tip.y, CANVAS_W / 2 - tip.x);
      ang = toCentre + (r() - 0.5) * 2.0;          // head back towards the middle, give or take ~57 degrees
    }
    const x2 = clamp(tip.x + Math.cos(ang) * len, M, CANVAS_W - M);
    const y2 = clamp(tip.y + Math.sin(ang) * len, M, CANVAS_H - M);
    const gen = tip.gen + 1;

    // Precompute this segment's look once, so redrawing it every frame never flickers.
    // The path zig-zags through 7 points, so even a single segment never looks ruled straight.
    const nx = -(y2 - tip.y) / (len || 1), ny = (x2 - tip.x) / (len || 1); // unit perpendicular
    const seam = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6, j = k === 0 || k === 6 ? 0 : (r() - 0.5) * CRACK_JAGGED;
      seam.push([tip.x + (x2 - tip.x) * t + nx * j, tip.y + (y2 - tip.y) * t + ny * j]);
    }
    cracks.push({
      x1: tip.x, y1: tip.y, x2, y2, nx, ny,
      w: Math.max(1.2, 5 - gen * 0.35),            // thick near the outbreak, thin at the edges
      strands: [(r() - 0.5) * 3, (r() - 0.5) * 4, (r() - 0.5) * 5], // three rough parallel strokes
      seam,
      stain: r() < 0.35 ? 10 + r() * 18 : 0,       // some tips bleed a small red stain
      mendAt: null,                                // when gold starts (ms), null = not mended yet
    });
    if (cracks.length > 400) cracks.shift();        // keep memory flat in a long run

    const next = { x: x2, y: y2, gen };
    if (r() < BRANCH_CHANCE) outbreak.tips.push(next); else outbreak.tips[i] = next; // fork or extend
    if (outbreak.tips.length > MAX_TIPS) outbreak.tips.shift();
    melkorDirty = true;
  }

  /** A rogue note: maybe start a new outbreak, then grow the crack (unless Melkor is contained). */
  function brushMelkor(n) {
    rogueNotes++;
    lastRogueAt = performance.now();
    if (!outbreak || n.bar - outbreak.lastBar > NEW_OUTBREAK_BARS) startOutbreak(n.bar);
    outbreak.lastBar = n.bar;
    // The crack keeps spreading for as long as Melkor plays. Once the honest agents have caught and
    // absorbed him (kintsugi on), every new segment is mended MEND_LAG_MS later: a red front keeps
    // creeping outwards while gold follows behind it. When he stops, the last red mends and fades.
    // (Before: catching him stopped the crack, and agents catch him in ~2 bars, so you saw almost nothing.)
    // How fast it spreads depends on what the honest agents can do:
    //   comms CUT (Void)   → nobody can absorb him: spreads fastest, stays red. Restore → gold sweeps it.
    //   caught (kintsugi)  → contained: spreads slower, gold follows MEND_LAG_MS behind.
    //   not caught yet     → normal speed, red.
    const grow = isolated ? SEGMENTS_PER_NOTE * ISOLATED_MULT : kintsugi ? CONTAINED_SEGMENTS : SEGMENTS_PER_NOTE;
    for (let i = 0; i < grow; i++) growCrack();       // each call adds exactly one segment to the end
    if (kintsugi && !isolated) {
      const at = performance.now() + MEND_LAG_MS;
      cracks.slice(-grow).forEach((c, i) => (c.mendAt = at + i * MEND_STAGGER_MS));
    }
    // Every 6th rogue note also stains the sun red on the main painting (the next scene repaints it).
    if (rogueNotes % 6 === 0) {
      watercolour('#b01a30', 45, 0.2, 0.4, 0.5);
      brush.circle(SUN.x, SUN.y, SUN.r * 0.95, 0.3);
      brush.noFill();
    }
  }

  /** Kintsugi: give every unmended segment a start time, in growth order, so gold walks outwards. */
  function scheduleMend() {
    const now = performance.now();
    let k = 0;
    for (const c of cracks) if (c.mendAt == null) c.mendAt = now + 300 + k++ * MEND_STAGGER_MS;
    if (k) melkorDirty = true;
  }

  /**
   * Redraw the whole Melkor layer from `cracks`. Runs each frame, but only while
   * something is changing (a new segment, gold appearing, red fading).
   */
  function redrawMelkor() {
    const now = performance.now();
    // Melkor fell silent for HEAL_AFTER_BARS: the world mends what's left without being asked.
    if (now - lastRogueAt > HEAL_AFTER_BARS * BAR_MS && cracks.some((c) => c.mendAt == null)) scheduleMend();
    if (!melkorDirty && !melkorAnimating) return;
    melkorDirty = false;
    melkorAnimating = false;
    mctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    mctx.lineCap = 'round'; mctx.lineJoin = 'round';

    for (const c of cracks) {
      // red: 1 = raw wound, 0 = gone. gold: 0 = none, 1 = fresh seam, SCAR_ALPHA = settled scar.
      let red = 1, gold = 0;
      if (c.mendAt != null) {
        const t = now - c.mendAt;
        if (t < 0) melkorAnimating = true;           // scheduled, not started yet
        else {
          const fade = clamp((t - GOLD_IN_MS) / RED_FADE_MS, 0, 1);
          gold = clamp(t / GOLD_IN_MS, 0, 1) * (1 - (1 - SCAR_ALPHA) * fade);
          red = 1 - fade;
          if (fade < 1) melkorAnimating = true;
        }
      }
      if (red > 0.01) {
        if (c.stain) {                               // soft red bleed around the crack end
          const g = mctx.createRadialGradient(c.x2, c.y2, 0, c.x2, c.y2, c.stain);
          g.addColorStop(0, `rgba(${CRACK_RGB}, ${0.35 * red})`);
          g.addColorStop(1, `rgba(${CRACK_RGB}, 0)`);
          mctx.fillStyle = g;
          mctx.beginPath(); mctx.arc(c.x2, c.y2, c.stain, 0, Math.PI * 2); mctx.fill();
        }
        c.strands.forEach((o, i) => {                // three rough strokes along the zig-zag path read as charcoal
          mctx.lineWidth = c.w * (1 - i * 0.3);
          mctx.strokeStyle = `rgba(${CRACK_RGB}, ${red * (0.9 - i * 0.25)})`;
          mctx.beginPath();
          c.seam.forEach(([x, y], k) => (k ? mctx.lineTo(x + c.nx * o, y + c.ny * o) : mctx.moveTo(x + c.nx * o, y + c.ny * o)));
          mctx.stroke();
        });
      }
      if (gold > 0.01) {                             // the seam: a wide dark-gold body, a bright core
        const path = () => { mctx.beginPath(); c.seam.forEach(([x, y], i) => (i ? mctx.lineTo(x, y) : mctx.moveTo(x, y))); };
        path(); mctx.lineWidth = c.w + 2.5; mctx.strokeStyle = `rgba(${GOLD_DARK}, ${gold * 0.85})`; mctx.stroke();
        path(); mctx.lineWidth = Math.max(1, c.w * 0.45); mctx.strokeStyle = `rgba(${GOLD_LIGHT}, ${gold})`; mctx.stroke();
      }
    }
  }

  const BRUSH = { architect: brushArchitect, weaver: brushWeaver, melodist: brushMelodist, pulse: brushPulse };

  /** Pick the brush for one note: Melkor if it's rogue, otherwise by role. */
  function paintNote(n) {
    const name = n.rogue ? 'melkor' : (n.role || ROLE_OF[n.from]);
    const fn = n.rogue ? brushMelkor : BRUSH[name];
    if (!fn) { console.warn('[paint-p5] no brush for note', n); return; } // DEBUG: unknown role = contract mismatch
    fn(n);
    stats.painted++; stats.perLayer[name]++;
  }

  // ===========================================================================
  // GHOSTS: only the NEXT bar's predictions, wiped when a new bar's arrive
  // ===========================================================================
  // A ghost = one agent guessing another's note. A white dashed circle; if the real
  // note matches, a dot in that agent's colour fills it. Ghosts about the Melodist sit
  // exactly where its line will go, so a hit visibly lands on its ghost.
  let lastGhostBar = null;
  const ghostXY = (g) => {
    const x = xForTime(g.bar, g.beat);
    if (g.about === 'poetA') return [x, melodyY(x, g.pitch)];
    return [x, CANVAS_H * 0.95 - ((g.pitch - 38) / 52) * CANVAS_H * 0.9]; // others: pitch over the full height
  };
  function drawGhost(g) {
    if (g.bar !== lastGhostBar) { gctx.clearRect(0, 0, CANVAS_W, CANVAS_H); lastGhostBar = g.bar; } // new bar: wipe
    const [x, y] = ghostXY(g);
    gctx.setLineDash([4, 3]);
    gctx.lineWidth = 2;
    gctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';  // CUSTOMISE: ghost colour
    gctx.beginPath(); gctx.arc(x, y, 10, 0, Math.PI * 2); gctx.stroke(); // CUSTOMISE: 10 = radius
    gctx.setLineDash([]);
    stats.ghosts++; stats.perLayer.ghosts++;
  }
  function ghostHit(g) {
    if (g.bar !== lastGhostBar) return;             // its circle was already wiped
    const [x, y] = ghostXY(g);
    gctx.fillStyle = palette(g.about, 55);
    gctx.beginPath(); gctx.arc(x, y, 6, 0, Math.PI * 2); gctx.fill();
    stats.ghostHits++;
  }

  // ===========================================================================
  // THE p5 SKETCH (instance mode: nothing leaks into the global scope)
  // ===========================================================================
  let fpsWindow = performance.now(), fpsFrames = 0, fadeColour = null;
  await new Promise((resolve) => {
    new p5((sk) => {
      p = sk;
      brush.instance(sk);                           // p5.brush docs: call before setup in instance mode
      sk.setup = () => {
        // p5 makes its OWN canvas (it ignores one handed to it), so we swap our placeholder
        // <canvas id="paint"> for it, keeping the id so the CSS for #paint still applies.
        const c = sk.createCanvas(CANVAS_W, CANVAS_H, sk.WEBGL).elt;
        sk.pixelDensity(1);                         // AFTER createCanvas, or hi-dpi screens get 2x (4x the work)
        canvas.replaceWith(c);
        c.id = 'paint';
        c.style.width = ''; c.style.height = '';    // let our CSS scale it (p5 sets fixed px sizes)
        canvas = c;
        // The two overlays, stacked on top in this order (CSS in index.html).
        melkorCanvas = overlayCanvas('melkor-layer', c);
        ghostCanvas = overlayCanvas('ghost-layer', melkorCanvas);
        mctx = melkorCanvas.getContext('2d');
        gctx = ghostCanvas.getContext('2d');

        sk.angleMode(sk.DEGREES);                   // brush angles (flowLine direction) in degrees
        sk.frameRate(FPS);
        sk.randomSeed(seed); sk.noiseSeed(seed);    // p5.brush hooks these, so its texture is repeatable
        brush.scaleBrushes(BRUSH_SCALE);
        sk.background(PAPER);
        fadeColour = sk.color(PAPER);
        fadeColour.setAlpha(FADE_ALPHA);
        resolve();
      };
      sk.draw = () => {
        // 1. Fade: every FADE_EVERY frames, lay a nearly see-through sheet of background colour
        //    over everything, so old paint sinks away and fresh strokes stand out.
        if (FADE_ALPHA > 0 && sk.frameCount % FADE_EVERY === 0) {
          sk.push();
          sk.noStroke(); sk.fill(fadeColour);
          sk.rect(-CANVAS_W / 2, -CANVAS_H / 2, CANVAS_W, CANVAS_H); // WebGL: (0,0) is the centre
          sk.pop();
        }
        // 2. Every due note becomes a drawing task.
        if (queue.length) {
          const now = nowAbs(), keep = [];
          for (const n of queue) {
            if (n.at <= now) { if (now - n.at > BAR_MS) stats.late++; tasks.push(() => paintNote(n)); }
            else keep.push(n);
          }
          queue = keep;
        }
        // 3. Run a few tasks, with (0,0) moved to the top-left corner.
        if (tasks.length) {
          sk.push();
          sk.translate(-CANVAS_W / 2, -CANVAS_H / 2);
          for (let i = 0; i < TASKS_PER_FRAME && tasks.length; i++) {
            try { tasks.shift()(); } catch (err) { console.error('[paint-p5] brush error', err); } // DEBUG
          }
          sk.pop();
        }
        // 4. The Melkor layer (only redraws while something changes).
        redrawMelkor();
        stats.tasks = tasks.length;
        stats.frames++; fpsFrames++;
        const t = performance.now();
        if (t - fpsWindow > 1000) { stats.fps = fpsFrames; fpsFrames = 0; fpsWindow = t; }
      };
    }, canvas.parentElement);                      // p5 builds its canvas inside #canvas-wrap
  });

  // ===========================================================================
  // PUBLIC API: everything stage.js may call (the same as paint.js)
  // ===========================================================================
  return {
    supportsSolo: false,                            // one shared painting canvas, so per-agent Solo isn't possible
    start() { p.loop(); },
    stop() { p.noLoop(); },
    setContext(from, mode, density) { agentCtx[from] = { mode, density }; },
    enqueueNote(n) {
      if (typeof n.at !== 'number' || !isFinite(n.at)) { console.warn('[paint-p5] note without valid at', n); return; }
      queue.push(n);
      if (queue.length > 2000) { console.warn('[paint-p5] queue overflow, dropping oldest'); queue = queue.slice(-1000); }
    },
    drawGhost, ghostHit,
    setGhostsVisible(on) { ghostCanvas.hidden = !on; },
    get ghostsVisible() { return !ghostCanvas.hidden; },
    /** stage.js turns this on when an honest agent reports 'absorb': mend every crack, centre outwards. */
    setKintsugi(on) {
      if (on && !kintsugi) scheduleMend();
      kintsugi = on;
    },
    get kintsugi() { return kintsugi; },
    /**
     * stage.js calls this when comms are cut (true) or restored (false). Cut: the crack spreads
     * faster and stays red. Restored while Melkor is caught: gold sweeps every unmended segment.
     */
    setIsolated(on) {
      if (isolated && !on && kintsugi) scheduleMend();
      isolated = on;
    },
    setSolo() {},
    get solo() { return []; },
    /** Saves the painting WITH Melkor's cracks and scars, WITHOUT the ghosts. */
    exportPNG(filename = `ea-painting-${Date.now()}.png`) {
      const out = document.createElement('canvas');
      out.width = CANVAS_W; out.height = CANVAS_H;
      const o = out.getContext('2d');
      o.drawImage(canvas, 0, 0);
      o.drawImage(melkorCanvas, 0, 0);
      out.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }, 'image/png');
    },
    reset() {
      queue = []; tasks.length = 0; cracks.length = 0; outbreak = null; washed.clear(); kintsugi = false; rogueNotes = 0;
      Object.keys(lastMelody).forEach((k) => delete lastMelody[k]);
      p.background(PAPER);
      mctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      gctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    },
    stats: () => ({ ...stats, queued: queue.length, cracks: cracks.length, mended: cracks.filter((c) => c.mendAt != null).length }),
    cracks: () => cracks,                           // DEBUG: EA.painter.cracks() in the console
    p5: () => p,                                    // DEBUG: EA.painter.p5() gives you the p5 instance
  };
}
