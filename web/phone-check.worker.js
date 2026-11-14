// Phone check worker: can this device run an agent? Loads agents.json and runs one real
// perception step (the 2048-dimension Eye-B view, the heaviest), timed.
import { prepareParams, prepareAnchors, embed, moodScores } from './core/perception.js';

self.onmessage = async (e) => {
  try {
    const id = e.data.id;
    const t = performance.now();
    const res = await fetch(new URL('./data/agents.json', import.meta.url), { cache: 'no-store' });
    const text = await res.text();
    const data = JSON.parse(text);
    const loadMs = Math.round(performance.now() - t);
    const prep = prepareParams(data.agents[id]);
    const anc = prepareAnchors(data.anchors);
    const x = new Float64Array(prep.dim).map((_, i) => Math.sin(i));
    const s = performance.now();
    const z = embed(prep, x);
    moodScores(prep, anc, z);
    self.postMessage({ ok: true, mb: (text.length / 1e6).toFixed(1), loadMs, stepMs: performance.now() - s });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
