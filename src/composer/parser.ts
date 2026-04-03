import { midiToFrequency, parseNoteLabel } from '../noteUtils';

export interface ParsedCompositionStep {
  id: string;
  token: string;
  label: string;
  type: 'note' | 'chord';
  durationMultiplier: number;
  midiValues: number[];
  frequencies: number[];
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

const FLAT_TO_SHARP: Record<string, string> = {
  DB: 'C#',
  EB: 'D#',
  GB: 'F#',
  AB: 'G#',
  BB: 'A#',
};

const CHORD_INTERVALS: Record<string, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dominant7: [0, 4, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
};

function createId(prefix: string, seed: string): string {
  return `${prefix}-${seed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

function normalizeNoteName(input: string): string | null {
  const normalized = input.toUpperCase();
  const sharpName = FLAT_TO_SHARP[normalized] ?? normalized;
  return NOTE_NAMES.includes(sharpName as (typeof NOTE_NAMES)[number])
    ? sharpName
    : null;
}

function noteNameToMidi(noteName: string, octave: number): number {
  const noteIndex = NOTE_NAMES.indexOf(noteName as (typeof NOTE_NAMES)[number]);
  return (octave + 1) * 12 + noteIndex;
}

function parseDurationSuffix(token: string): {
  core: string;
  durationMultiplier: number;
} {
  const match = token.match(/^(.*?)(x(\d+(?:\.\d+)?)|\/(\d+(?:\.\d+)?))$/i);
  if (!match) {
    return {
      core: token,
      durationMultiplier: 1,
    };
  }

  const core = match[1]?.trim();
  const multiplyBy = match[3] ? Number(match[3]) : null;
  const divideBy = match[4] ? Number(match[4]) : null;

  if (!core || (multiplyBy !== null && !(multiplyBy > 0)) || (divideBy !== null && !(divideBy > 0))) {
    return {
      core: token,
      durationMultiplier: 1,
    };
  }

  return {
    core,
    durationMultiplier: multiplyBy ?? 1 / (divideBy ?? 1),
  };
}

function parseNoteStep(token: string, durationMultiplier: number): ParsedCompositionStep | null {
  const frequency = parseNoteLabel(token);
  if (frequency === null) {
    return null;
  }

  const match = token.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!match) {
    return null;
  }

  const noteName = normalizeNoteName(`${match[1]}${match[2]}`);
  if (!noteName) {
    return null;
  }

  const octave = Number(match[3]);
  const midi = noteNameToMidi(noteName, octave);

  return {
    id: createId('step', `${token}-${durationMultiplier}`),
    token,
    label: token.toUpperCase(),
    type: 'note',
    durationMultiplier,
    midiValues: [midi],
    frequencies: [frequency],
  };
}

function parseChordStep(token: string, durationMultiplier: number): ParsedCompositionStep | null {
  const match = token
    .trim()
    .match(/^([A-Ga-g])([#b]?)(maj7|m7|sus2|sus4|dim|m|7)?$/);
  if (!match) {
    return null;
  }

  const noteName = normalizeNoteName(`${match[1]}${match[2]}`);
  if (!noteName) {
    return null;
  }

  const qualityToken = match[3] ?? '';
  const quality =
    qualityToken === ''
      ? 'major'
      : qualityToken === 'm'
        ? 'minor'
        : qualityToken === '7'
          ? 'dominant7'
          : qualityToken;

  const intervals = CHORD_INTERVALS[quality];
  if (!intervals) {
    return null;
  }

  const rootMidi = noteNameToMidi(noteName, 3);
  const midiValues = intervals.map((interval) => rootMidi + interval);

  return {
    id: createId('step', `${token}-${durationMultiplier}`),
    token,
    label: token,
    type: 'chord',
    durationMultiplier,
    midiValues,
    frequencies: midiValues.map((midi) => midiToFrequency(midi)),
  };
}

export function parseCompositionSource(source: string): ParsedCompositionStep[] {
  return source
    .split(/[\s|]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const { core, durationMultiplier } = parseDurationSuffix(token);
      return (
        parseNoteStep(core, durationMultiplier) ??
        parseChordStep(core, durationMultiplier)
      );
    })
    .filter((step): step is ParsedCompositionStep => Boolean(step));
}

