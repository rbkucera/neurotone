export type CarrierDisplayMode = 'hz' | 'note';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

const FLAT_TO_SHARP: Record<string, string> = {
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
};

export const NOTE_SLIDER_MIN_MIDI = Math.ceil(frequencyToMidi(40));
export const NOTE_SLIDER_MAX_MIDI = Math.floor(frequencyToMidi(1200));

export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function frequencyToMidi(frequency: number): number {
  return 69 + 12 * Math.log2(frequency / 440);
}

export function frequencyToNearestMidi(frequency: number): number {
  return Math.round(frequencyToMidi(frequency));
}

export function midiToNoteLabel(midi: number): string {
  const roundedMidi = Math.round(midi);
  const noteName = NOTE_NAMES[((roundedMidi % 12) + 12) % 12];
  const octave = Math.floor(roundedMidi / 12) - 1;
  return `${noteName}${octave}`;
}

export function frequencyToNoteLabel(frequency: number): string {
  return midiToNoteLabel(frequencyToNearestMidi(frequency));
}

export function parseNoteLabel(input: string): number | null {
  const match = input.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!match) {
    return null;
  }

  const [, rawLetter, accidental, rawOctave] = match;
  const letter = rawLetter.toUpperCase();
  const octave = Number(rawOctave);
  const combined = `${letter}${accidental}`;
  const normalized = FLAT_TO_SHARP[combined] ?? combined;
  const noteIndex = NOTE_NAMES.indexOf(normalized as (typeof NOTE_NAMES)[number]);

  if (noteIndex === -1 || Number.isNaN(octave)) {
    return null;
  }

  const midi = (octave + 1) * 12 + noteIndex;
  return midiToFrequency(midi);
}

export function clampMidiToCarrierRange(midi: number): number {
  return Math.min(NOTE_SLIDER_MAX_MIDI, Math.max(NOTE_SLIDER_MIN_MIDI, Math.round(midi)));
}
