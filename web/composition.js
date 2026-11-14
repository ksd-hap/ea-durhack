/**
 * composition.js: the SET PAINTING every performance builds up (Role 4)
 * ----------------------------------------------------------------------------
 * The agents don't scatter marks at random. They all paint INTO this one fixed
 * landscape, each agent owning certain parts of it:
 *
 *     ┌──────────────────────────────────────────────┐
 *     │  ~ CLOUDS ~ (Weaver long notes)         SUN  │  ← Architect paints the sun each scene;
 *     │  SKY  (Architect washes, Pulse stars)        │    Melkor stains it red
 *     │      /\    MOUNTAINS   /\        /\          │  ← Architect
 *     │ ~~~~~ ridge line = MELODIST'S luminous line ~│  ← the melody traces the skyline
 *     │   HILLS  (Architect)                         │
 *     │ ≈≈≈≈≈≈≈≈≈≈≈  WATER + ripples (Weaver) ≈≈≈≈≈≈≈ │
 *     │  SHORE (Architect)                           │
 *     └──────────────────────────────────────────────┘
 *
 * Every shape is in canvas pixels: x from 0 (left) to 1920, y from 0 (TOP) to 1080.
 * So a SMALLER y is HIGHER on screen.
 *
 * HOW SHAPES ARE MADE: you write a few rough CONTROL POINTS (the corners), and the helpers
 * below round them off (smoothLine / smoothShape) and give long edges a gentle wave
 * (wavyEdge), so nothing in the painting is a ruled straight line.
 *
 * CUSTOMISE: move any control point, change SMOOTH_PASSES, or add landforms (see LANDFORMS).
 * ----------------------------------------------------------------------------
 */

export const W = 1920;
export const H = 1080;

/** CUSTOMISE: how rounded the outlines are. 0 = sharp corners, 1 = soft, 3 = very round. */
const SMOOTH_PASSES = 2;

// ---- Shape helpers ------------------------------------------------------------------------

/**
 * Chaikin smoothing of an OPEN line (like a ridge): each pass cuts every corner,
 * turning a zig-zag into a soft curve. The two end points stay where they are.
 */
export function smoothLine(pts, passes = SMOOTH_PASSES) {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1];
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25], [x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    out.push(p.at(-1));
    p = out;
  }
  return p;
}

/** Chaikin smoothing of a CLOSED shape (an island, a lake): rounds every corner, including the last one. */
export function smoothShape(pts, passes = SMOOTH_PASSES) {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25], [x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    p = out;
  }
  return p;
}

/**
 * A gently wavy horizontal edge across the whole canvas (a little past both sides), left to right.
 * y: average height · amp: wave size in px · waves: how many waves across · seed: shifts the pattern
 */
export function wavyEdge(y, amp = 8, waves = 3, seed = 0) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    pts.push([-40 + (W + 80) * t,
      y + Math.sin(t * Math.PI * 2 * waves + seed) * amp + Math.sin(t * Math.PI * 2 * waves * 2.3 + seed * 3) * amp * 0.35]);
  }
  return pts;
}

// ---- The landscape --------------------------------------------------------------------------

/** Sky (kept for reference; the painter uses SKY_SHAPE below). */
export const SKY = { x: 0, y: 0, w: W, h: 620 };

/** The sun (or moon), high in the top-right, clear of the peaks. Its colour comes from the Architect's mood; Melkor turns it red. */
export const SUN = { x: 1650, y: 120, r: 95 };

/**
 * Far mountains: CONTROL POINTS for the ridge, left to right. They get smoothed into RIDGE.
 * Peaks reach about a sixth of the way down (y 170 to 230); valleys sit around y 300 to 400.
 * CUSTOMISE: lower a y number to make that peak taller.
 */
export const MOUNTAIN_RIDGE = [
  [-40, 410], [0, 400], [140, 330], [260, 230], [380, 300], [520, 190], [660, 290], [780, 240],
  [920, 330], [1060, 270], [1200, 170], [1330, 260], [1480, 230], [1620, 320], [1760, 270], [1920, 340], [W + 40, 350],
];
/** The smoothed ridge: what actually gets painted, and what the melody line rides. */
export const RIDGE = smoothLine(MOUNTAIN_RIDGE);

/**
 * The sky as a SHAPE: from above the top edge down to just below the ridge (20px of overlap,
 * so no gap shows). Because it stops at the ridge, sky washes never paint over the mountains.
 */
export const SKY_SHAPE = [[-60, -60], [W + 60, -60], ...[...RIDGE].reverse().map(([x, y]) => [x, y + 20])];

/** Mountains = the ridge, then back along a wavy base hidden behind the hills. */
export const MOUNTAINS = [...RIDGE, ...wavyEdge(720, 10, 2.5, 1).reverse()];

/** Hills: CONTROL POINTS for their top edge (smoothed), with a wavy base hidden by the water. */
export const HILL_TOP = [
  [-40, 650], [0, 640], [200, 600], [420, 625], [640, 580], [900, 630], [1150, 600], [1400, 640],
  [1650, 605], [1920, 630], [W + 40, 640],
];
export const HILLS = [...smoothLine(HILL_TOP), ...wavyEdge(800, 8, 3, 2).reverse()];

/** The lake: the band where the Weaver's ripple glazes go. */
export const LAKE = { y0: 770, y1: 930 };

/**
 * The body of water: a wavy top tucked UNDER the hills (so no black gap shows) and a wavy
 * bottom hidden by the shore. CUSTOMISE: the 7 and 6 are wave sizes in px.
 */
export const WATER = [...wavyEdge(745, 7, 3, 4), ...wavyEdge(965, 6, 2, 5).reverse()];

/**
 * Clouds: a band high in the sky, drifting around the peaks (the Weaver's long notes, 2+ beats).
 * CUSTOMISE: y0 = top of the band, y1 = bottom. Higher pitches drift nearer the top.
 */
export const CLOUDS = { y0: 50, y1: 180 };

/** Shore: CONTROL POINTS for its top edge (smoothed), down to below the canvas bottom. */
export const SHORE_TOP = [
  [-40, 905], [0, 900], [260, 920], [520, 905], [800, 935], [1100, 915], [1400, 940], [1700, 920], [1920, 935], [W + 40, 930],
];
export const SHORE = [...smoothLine(SHORE_TOP), [W + 40, H + 40], [-40, H + 40]];

/**
 * LANDFORMS: the land shapes the Architect paints, one per chord, in this order, then repeats.
 * Listed FAR to NEAR, because later shapes are painted on top of earlier ones.
 *
 * TO ADD A LANDFORM (no other file needs changing):
 *   1. Define its rough corners above, rounded with smoothShape, e.g.
 *        export const ISLAND = smoothShape([[1150, 840], [1250, 805], [1380, 815], [1430, 850], [1210, 865]]);
 *   2. Add a line to this list where it belongs, far to near, e.g.
 *        { name: 'island', points: ISLAND, light: 10, tint: 270, mix: 0.6, sat: 30 },
 *   3. Reload the page (Ctrl+Shift+R).
 * Peaks are LOW y numbers (y = 0 is the top edge). Sketch at 1920 x 1080 in any paint app
 * and read the cursor position to get coordinates.
 */
export const LANDFORMS = [
  // light: 0-100. Far = lighter, near = darker, which reads as distance (like the reference image).
  //        (paint-p5.js adds LIGHT_BOOST = 15 to these, so 20 shows as 35.)
  // tint:  a hue (0 = red, 120 = green, 210 = blue, 260 = violet) the mood colour is pulled towards
  // mix:   how far towards the tint, 0 = pure mood colour, 1 = pure tint
  // sat:   saturation 0-100. Lower = a calmer silhouette that blends with the sky
  { name: 'far mountains', points: MOUNTAINS, light: 22, tint: 255, mix: 0.55, sat: 38 },
  { name: 'hills',         points: HILLS,     light: 13, tint: 265, mix: 0.6,  sat: 32 },
  { name: 'water',         points: WATER,     light: 20, tint: 210, mix: 0.75, sat: 45 },
  { name: 'shore',         points: SHORE,     light: 5,  tint: 270, mix: 0.7,  sat: 28 },
];

/**
 * Height of the (smoothed) mountain ridge at any x. The Melodist uses it so the melody line
 * rides the skyline, and Pulse uses it to keep stars in the sky.
 */
export function ridgeY(x) {
  const pts = RIDGE;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x <= x1) return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
  }
  return pts.at(-1)[1];
}
