// stage.js — UI, controls, metrics panel; the hub (Ilúvatar) lives here. [Role 4 OWNS THIS FILE]
//
// Placeholder. Use Role 2's runtime for every worker/channel concern:
//
//   import { createRuntime } from './runtime.js';
//   const rt = await createRuntime({ seed: 0 });
//   rt.onTelemetry(msg => { /* see CONTRACTS.md "Telemetry messages" */ });
//   startButton.onclick = async () => { await audio.start(); rt.start(); };  // Start = audio gesture + hub start
//   rt.endRehearsal(); rt.cut(); rt.restore(); rt.setLoss(p);
//   rt.setRogue('poetB', true); rt.setBaseline(true); rt.setRandomRotation(true) // rehearsal only
//
// Metrics must be computed ONLY from telemetry. Never send musical info to agents.

import { createRuntime } from './runtime.js';

const btn = document.getElementById('start');
btn?.addEventListener('click', async () => {
  btn.disabled = true;
  const rt = await createRuntime({ seed: 0 });
  rt.onTelemetry((m) => {
    if (m.type === 'scene') console.log('scene', m.index, m.truth);
  });
  rt.start();
  window.rt = rt; // handy in DevTools
});
