// audio.js — local Tone.js playback. [Role 3]
// Desktop: createAudio()
// Phone: createAudio({ voice: 'eyeA', phoneSpeaker: true })
// Load vendor/tone.js first. Call start() from the user's tap.

const BPM = 72;
const BEAT_SECONDS = 60 / BPM;

const ROLES = [
  'architect',
  'melodist',
  'weaver',
  'pulse',
];

const ROLE_OF = {
  eyeA: 'architect',
  poetA: 'melodist',
  eyeB: 'weaver',
  poetB: 'pulse',
};

const absoluteNow = () =>
  performance.timeOrigin + performance.now();

export function createAudio({
  voice = null,
  phoneSpeaker = false,
} = {}) {
  const selected = Object.hasOwn(ROLE_OF, voice)
    ? ROLE_OF[voice]
    : voice;

  if (selected !== null && !ROLES.includes(selected)) {
    throw new Error(`Unknown audio voice: ${voice}`);
  }

  let Tone;
  let rawContext;
  let graph = null;
  let starting = null;
  let driftTimer = null;
  let ready = false;
  let disposed = false;
  let offset = 0;

  const stats = {
    scheduled: 0,
    late: 0,
    invalid: 0,
    notReady: 0,
    filtered: 0,
    errors: 0,
    lastError: null,
  };

  function measureOffset() {
    return rawContext.currentTime - absoluteNow() / 1000;
  }

  function buildGraph() {
    const nodes = [];

    const keep = (node) => {
      nodes.push(node);
      return node;
    };

    try {
      const master = keep(new Tone.Gain(0.7));

      const reverb = keep(
        new Tone.Reverb({
          decay: 8,
          wet: 0.35,
        }),
      );

      const limiter = keep(new Tone.Limiter(-1));

      master.connect(reverb);
      reverb.connect(limiter);
      limiter.toDestination();

      // Dry rogue bus bypasses the reverb.
      const rogueGain = keep(new Tone.Gain(0.7));
      rogueGain.connect(limiter);

      const instruments = Object.create(null);
      const rogueInstruments = Object.create(null);

      function ensureRogueInstrument(role) {
        if (rogueInstruments[role]) {
          return rogueInstruments[role];
        }

        // Ominous, not beeping: a detuned saw growl that swells in
        // slowly, darkened by a lowpass, with a slow wobble, plus a
        // sub-octave sine for weight. Mostly dry so it cuts through,
        // with some reverb so it hangs in the hall like a shadow.
        const darken = keep(
          new Tone.Filter({
            frequency: phoneSpeaker ? 1400 : 900,
            type: 'lowpass',
            Q: 2,
          }),
        );
        darken.connect(rogueGain);
        darken.connect(master); // reverb send

        const distortion = keep(
          new Tone.Distortion({
            distortion: 0.45,
            oversample: '2x',
          }),
        );
        distortion.connect(darken);

        const wobble = keep(
          new Tone.Vibrato({ frequency: 3.2, depth: 0.12 }),
        );
        wobble.connect(distortion);

        const growl = keep(
          new Tone.PolySynth(Tone.Synth, {
            oscillator: {
              type: 'fatsawtooth',
              count: 3,
              spread: 34,
            },
            envelope: {
              attack: 0.35,
              decay: 0.6,
              sustain: 0.7,
              release: 2.5,
            },
          }),
        );
        growl.volume.value = -14;
        growl.maxPolyphony = 16;
        growl.connect(wobble);

        const sub = keep(
          new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'sine' },
            envelope: {
              attack: 0.5,
              decay: 0.4,
              sustain: 0.8,
              release: 3,
            },
          }),
        );
        sub.volume.value = phoneSpeaker ? -40 : -12;
        sub.maxPolyphony = 16;
        sub.connect(darken);

        const instrument = {
          triggerAttackRelease(freq, duration, time, vel) {
            growl.triggerAttackRelease(freq, duration, time, vel);
            sub.triggerAttackRelease(freq / 2, duration, time, vel);
          },
        };

        rogueInstruments[role] = instrument;
        return instrument;
      }

      function ensureInstrument(role) {
        if (instruments[role]) {
          return instruments[role];
        }

        let instrument;

        if (role === 'architect') {
          const lowpass = keep(
            new Tone.Filter(800, 'lowpass'),
          );
          lowpass.connect(master);

          instrument = keep(
            new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'sine' },
              envelope: {
                attack: 2,
                decay: 0.3,
                sustain: 0.65,
                release: 4,
              },
              volume: -13,
            }),
          );

          instrument.connect(lowpass);
        } else if (role === 'melodist') {
          const delay = keep(
            new Tone.FeedbackDelay({
              delayTime: BEAT_SECONDS * 0.75,
              feedback: 0.3,
              wet: 0.22,
            }),
          );
          delay.connect(master);

          instrument = keep(
            new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'triangle' },
              envelope: {
                attack: 0.03,
                decay: 0.12,
                sustain: 0.35,
                release: 0.6,
              },
              volume: -10,
            }),
          );

          instrument.connect(delay);
        } else if (role === 'weaver') {
          instrument = keep(
            new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'sine' },
              envelope: {
                attack: 0.4,
                decay: 0.2,
                sustain: 0.55,
                release: 1.5,
              },
              volume: -15,
            }),
          );

          instrument.connect(master);
        } else if (role === 'pulse') {
          instrument = keep(
            new Tone.PolySynth(Tone.Synth, {
              oscillator: { type: 'triangle' },
              envelope: {
                attack: 0.002,
                decay: 0.13,
                sustain: 0,
                release: 0.08,
              },
              volume: -16,
            }),
          );

          instrument.connect(master);
        } else {
          throw new Error(`Unknown instrument: ${role}`);
        }

        instrument.maxPolyphony = 16;
        instruments[role] = instrument;

        return instrument;
      }

      const initialRoles = selected ? [selected] : ROLES;

      for (const role of initialRoles) {
        ensureInstrument(role);
      }

      return {
        nodes,
        reverb,
        instruments,
        ensureInstrument,
        rogueInstruments,
        ensureRogueInstrument,
      };
    } catch (error) {
      for (const node of nodes.reverse()) {
        node.dispose();
      }

      throw error;
    }
  }

  function clearGraph() {
    ready = false;
    clearInterval(driftTimer);
    driftTimer = null;

    if (!graph) return;

    for (const node of [...graph.nodes].reverse()) {
      node.dispose();
    }

    graph = null;
  }

  async function prepare() {
    const built = buildGraph();
    graph = built;

    await built.reverb.ready;

    if (disposed) {
      throw new Error(
        'Audio disposed. Create a new audio engine.',
      );
    }

    offset = measureOffset();
    ready = true;

    driftTimer = setInterval(() => {
      if (ready && rawContext.state === 'running') {
        offset += (measureOffset() - offset) * 0.1;
      }
    }, 30000);
  }

  async function start() {
    if (disposed) {
      throw new Error(
        'Audio disposed. Create a new audio engine.',
      );
    }

    Tone = globalThis.Tone;

    if (!Tone) {
      throw new Error(
        'Load local vendor/tone.js before starting audio.',
      );
    }

    await Tone.start();

    if (disposed) {
      throw new Error(
        'Audio disposed. Create a new audio engine.',
      );
    }

    rawContext = Tone.getContext().rawContext;

    if (rawContext.state !== 'running') {
      throw new Error(
        'Audio blocked. Press Start again.',
      );
    }

    if (!starting) {
      starting = prepare().catch((error) => {
        clearGraph();
        starting = null;
        throw error;
      });
    }

    await starting;
    offset = measureOffset();
  }

  function onNote(note) {
    if (note?.type && note.type !== 'note') {
      return false;
    }

    if (
      !ready ||
      disposed ||
      rawContext.state !== 'running'
    ) {
      stats.notReady++;
      return false;
    }

    if (
      !ROLES.includes(note?.role) ||
      !Number.isFinite(note?.at) ||
      !Number.isInteger(note.pitch) ||
      note.pitch < 0 ||
      note.pitch > 127 ||
      !Number.isFinite(note.dur) ||
      note.dur <= 0 ||
      !Number.isFinite(note.vel) ||
      note.vel <= 0 ||
      note.vel > 1
    ) {
      stats.invalid++;
      return false;
    }

    if (selected && note.role !== selected) {
      stats.filtered++;
      return false;
    }

    const time = note.at / 1000 + offset;
    const duration = note.dur * BEAT_SECONDS;

    if (
      !Number.isFinite(time) ||
      !Number.isFinite(duration)
    ) {
      stats.invalid++;
      return false;
    }

    if (time <= rawContext.currentTime) {
      stats.late++;
      return false;
    }

    // Honest cover parts may need a supporting instrument.
    let role = note.role;

    if (role === 'melodist' && note.pitch < 62) {
      role = 'architect';
    }

    if (role === 'architect' && note.pitch >= 74) {
      role = 'pulse';
    }

    if (role === 'pulse' && note.pitch < 74) {
      role = 'weaver';
    }

    let pitch = note.pitch;
    let length = duration;

    // Melkor sounds low and long: drop to a dark register (same pitch
    // class, so the clash is unchanged) and let each note swell for
    // 1.5 beats instead of a short stab.
    if (note.rogue) {
      const ceiling = phoneSpeaker ? 62 : 55;
      while (pitch > ceiling) pitch -= 12;
      length = Math.max(duration, 1.5 * BEAT_SECONDS);
    }

    if (phoneSpeaker) {
      while (pitch < 50) {
        pitch += 12;
      }
    }

    try {
      const instrument = note.rogue
        ? graph.ensureRogueInstrument(note.role)
        : graph.ensureInstrument(role);

      instrument.triggerAttackRelease(
        Tone.Frequency(pitch, 'midi').toFrequency(),
        length,
        time,
        note.vel,
      );

      stats.scheduled++;
      return true;
    } catch (error) {
      stats.errors++;
      stats.lastError = String(error.message ?? error);
      return false;
    }
  }

  function getStats() {
    return {
      ...stats,
      ready,
      state: rawContext?.state ?? 'not-started',
      voice: selected,
      phoneSpeaker: Boolean(phoneSpeaker),
      instruments: Object.keys(graph?.instruments ?? {}),
      rogueInstruments: Object.keys(
        graph?.rogueInstruments ?? {},
      ),
    };
  }

  function dispose() {
    if (disposed) return;

    disposed = true;
    clearGraph();
  }

  return {
    start,
    onNote,
    getStats,
    dispose,
  };
}