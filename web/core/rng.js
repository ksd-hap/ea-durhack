// Seeded randomness shared by every role. Pure: no I/O, no Math.random.
// Every agent gets its own stream so runs and the simulator are reproducible.

/** mulberry32: tiny, fast, good-enough 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string to a uint32. */
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Derive a per-stream seed from a name (e.g. 'eyeA', 'net:eyeA') and a run seed. */
export function seedFor(name, seed = 0) {
  return (hashString(name) ^ Math.imul((seed | 0) + 1, 0x9e3779b1)) >>> 0;
}
