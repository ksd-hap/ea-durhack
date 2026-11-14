// audio.js — local Tone.js playback. [Role 3]
//
// Desktop: createAudio()
// Phone: createAudio({ voice: 'eyeA', phoneSpeaker: true })
//
// voice accepts an agent ID or musical role.
// Load vendor/tone.js first.
// Call start() directly from the Start button or phone tap.

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

      const instruments = Object.create(null);

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

      // Phones initially create only their own instrument.
      // Cover instruments are added when needed.
      const initialRoles = selected ? [selected] : ROLES;

      for (const role of initialRoles) {
        ensureInstrument(role);
      }

      return {
        nodes,
        reverb,
        instruments,
        ensureInstrument,
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

    // No await precedes this: iOS needs it inside the tap.
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

    // Corruption retains the agent's own instrument.
    // Cover notes outside its usual register use
    // the missing job's supporting instrument.
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

    // D2 becomes D3. Already raised notes stay unchanged.
    if (phoneSpeaker) {
      while (pitch < 50) {
        pitch += 12;
      }
    }

    try {
      const instrument = graph.ensureInstrument(role);

      instrument.triggerAttackRelease(
        Tone.Frequency(pitch, 'midi').toFrequency(),
        duration,
        time,
        note.vel,
      );

      stats.scheduled++;
      return true;
    } catch (error) {
      // An audio error must not interrupt painting/metrics.
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
