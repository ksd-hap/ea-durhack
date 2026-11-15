// story.js — one line of story for what the run is doing right now. [Role 2]
// Display only: built from what the Stage already knows (its own buttons + agents' status
// telemetry). Agents never see it. The lines are our own, written in the spirit of the
// Ainulindalë (the Music of the Ainur), not quotations.
//
//   import { storyKey, STORY, createNarrator } from './story.js';
//   const narrator = createNarrator();
//   const key = narrator.update(storyKey({ started, hubOpen, loss, wasCut, randomRot, baseline, status }));
//   show(STORY[key]);   // { title, line }

export const STORY = {
  idle: { title: 'Before the Music', line: 'In the timeless halls, four voices wait for the theme.' },
  theme: { title: 'The Great Music', line: 'Four voices take up one theme, each singing what it alone perceives.' },
  noise: { title: 'Voices without understanding', line: 'Each sings, but none can grasp the others’ meaning, and the music comes apart.' },
  conductor: { title: 'One voice commands', line: 'A single conductor dictates; the others only echo.' },
  theirs: { title: 'Ilúvatar falls silent', line: 'The theme is theirs now, carried by what they hear in one another.' },
  thin: { title: 'The air grows thin', line: 'Some voices are lost between the singers, yet the theme holds.' },
  discord: { title: 'Melkor’s discord', line: 'One voice turns aside to sing a theme of its own, against the rest.' },
  suspect: { title: 'A note that does not belong', line: 'The others hear the discord and begin to doubt its singer.' },
  absorb: { title: 'The discord woven in', line: 'A faithful voice takes the clashing notes and weaves them back into the theme.' },
  caught: { title: 'Melkor named', line: 'The discordant voice is known; the others no longer trust its song.' },
  covered: { title: 'The part taken up', line: 'Another voice sings the corrupted part, and the theme is whole again.' },
  void: { title: 'The Void', line: 'No voice can hear another. Each sings on from what it last believed.' },
  voidRogue: { title: 'Discord in the Void', line: 'Cut off and unseen, the corrupted voice sings against them all.' },
  voidCaught: { title: 'Faithful in the Void', line: 'Alone, the others keep the theme Melkor could not break.' },
  restored: { title: 'The voices return', line: 'They hear one another again, and the theme comes back together.' },
};

/** Which part of the run a key belongs to: a change of part is shown at once, never held back. */
const PART = { idle: 'idle', void: 'void', voidRogue: 'void', voidCaught: 'void', restored: 'after' };
const partOf = (key) => PART[key] ?? 'halls';

/**
 * The story moment for the current state.
 *   status: latest 'status' telemetry per agent id ({rogue, suspected[], flagged[], response, covering})
 */
export function storyKey({ started = false, hubOpen = true, loss = 0, wasCut = false, randomRot = false, baseline = false, status = {} } = {}) {
  if (!started) return 'idle';
  const all = Object.values(status).filter(Boolean);
  const rogues = new Set(all.filter((s) => s.rogue).map((s) => s.from));
  const honest = all.filter((s) => !s.rogue);
  const anyRogue = rogues.size > 0;
  const named = (list) => (list ?? []).some((x) => rogues.has(x));
  const caught = honest.some((s) => named(s.flagged));
  const suspected = honest.some((s) => named(s.suspected));
  const covering = honest.some((s) => s.covering);
  const absorbing = honest.some((s) => s.response === 'absorb');

  if (loss >= 1) return anyRogue ? (caught ? 'voidCaught' : 'voidRogue') : 'void';
  if (anyRogue) {
    if (covering) return 'covered';
    if (caught) return 'caught';
    if (absorbing) return 'absorb';
    if (suspected) return 'suspect';
    return 'discord';
  }
  if (loss > 0) return 'thin';
  if (wasCut) return 'restored';
  if (randomRot) return 'noise';
  if (baseline) return 'conductor';
  if (!hubOpen) return 'theirs';
  return 'theme';
}

/**
 * Holds each line long enough to read: within one part of the run a new line waits until the
 * current one has been up for holdMs (agents' status flickers bar to bar), but a change of
 * part (start, cut, restore) shows at once.
 */
export function createNarrator({ holdMs = 5000, now = () => performance.now() } = {}) {
  let key = null;
  let since = -Infinity;
  return {
    get key() { return key; },
    update(next) {
      const t = now();
      if (next !== key && (key === null || partOf(next) !== partOf(key) || t - since >= holdMs)) {
        key = next;
        since = t;
      }
      return key;
    },
  };
}
