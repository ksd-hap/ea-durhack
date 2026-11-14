// audio.js — Tone.js playback. [Role 3]
// Load vendor/tone.js before calling start().
// API: createAudio() -> { start, onNote, getStats, dispose }.

const BPM = 72;
const BEAT_SECONDS = 60 / BPM;
const absoluteNow = () =>
  performance.timeOrigin + performance.now();

export function createAudio() {
  let Tone;
  let rawContext;
  let graph = null;
  let starting = null;
  let ready = false;
  let disposed = false;
  let offset = 0;
  let driftTimer = null;

  const stats = {
    scheduled: 0,
    late: 0,
    invalid: 0,
    notReady: 0,
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

      // Architect: soft sine pads and drone.
      const lowpass = keep(
        new Tone.Filter(800, 'lowpass'),
      );
      lowpass.connect(master);

      const architect = keep(
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
      architect.maxPolyphony = 16;
      architect.connect(lowpass);

      // Melodist: triangle lead with dotted-eighth delay.
      const delay = keep(
        new Tone.FeedbackDelay({
          delayTime: BEAT_SECONDS * 0.75,
          feedback: 0.3,
          wet: 0.22,
        }),
      );
      delay.connect(master);

      const melodist = keep(
        new Tone.Synth({
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
      melodist.connect(delay);

      // Weaver: gentle, sustained sine notes.
      const weaver = keep(
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
      weaver.maxPolyphony = 16;
      weaver.connect(master);

      // Pulse: short, quiet plucks.
      const pulse = keep(
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
      pulse.maxPolyphony = 16;
      pulse.connect(master);

      // Melkor: brighter and louder than ordinary Pulse.
      const melkor = keep(
        new Tone.Synth({
          oscillator: { type: 'sawtooth' },
          envelope: {
            attack: 0.005,
            decay: 0.1,
            sustain: 0.2,
            release: 0.15,
          },
          volume: -10,
        }),
      );
      melkor.connect(master);

      return {
        nodes,
        reverb,
        limiter,
        instruments: {
          architect,
          melodist,
          weaver,
          pulse,
          melkor,
        },
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

    // Finish generating the reverb before accepting notes.
    await built.reverb.ready;

    if (disposed) {
      throw new Error(
        'Audio disposed. Create a new audio engine.',
      );
    }

    offset = measureOffset();
    ready = true;

    // Smoothly correct drift between the two clocks.
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

    // Call start() directly from the Start button click.
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

    // Repeated Start calls reuse the same instruments.
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
    // Ignore scene, ghost and other telemetry messages.
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

    const role = note?.rogue ? 'melkor' : note?.role;

    const instrument = Object.hasOwn(
      graph.instruments,
      role,
    )
      ? graph.instruments[role]
      : undefined;

    if (
      !instrument ||
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

    const time = note.at / 1000 + offset;
    const duration = note.dur * BEAT_SECONDS;

    if (
      !Number.isFinite(time) ||
      !Number.isFinite(duration)
    ) {
      stats.invalid++;
      return false;
    }

    // Drop late notes instead of playing a sudden backlog.
    if (time <= rawContext.currentTime) {
      stats.late++;
      return false;
    }

    const frequency = Tone.Frequency(
      note.pitch,
      'midi',
    ).toFrequency();

    instrument.triggerAttackRelease(
      frequency,
      duration,
      time,
      note.vel,
    );

    stats.scheduled++;
    return true;
  }

  function getStats() {
    return {
      ...stats,
      ready,
      state: rawContext?.state ?? 'not-started',
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
