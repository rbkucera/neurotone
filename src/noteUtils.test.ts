import { describe, expect, it } from 'vitest';

import {
  clampMidiToCarrierRange,
  frequencyToNearestMidi,
  frequencyToNoteLabel,
  midiToFrequency,
  midiToNoteLabel,
  parseNoteLabel,
} from './noteUtils';

describe('note utils', () => {
  it('converts midi notes into note labels', () => {
    expect(midiToNoteLabel(57)).toBe('A3');
    expect(midiToNoteLabel(61)).toBe('C#4');
  });

  it('maps frequencies to the nearest note label', () => {
    expect(frequencyToNoteLabel(220)).toBe('A3');
    expect(frequencyToNearestMidi(440)).toBe(69);
  });

  it('parses sharp and flat note input', () => {
    expect(parseNoteLabel('A3')).toBeCloseTo(220, 6);
    expect(parseNoteLabel('Ab3')).toBeCloseTo(midiToFrequency(56), 6);
    expect(parseNoteLabel('C#4')).toBeCloseTo(midiToFrequency(61), 6);
  });

  it('returns null for invalid note text', () => {
    expect(parseNoteLabel('H2')).toBeNull();
    expect(parseNoteLabel('A#')).toBeNull();
  });

  it('clamps midi note values to the carrier slider range', () => {
    expect(clampMidiToCarrierRange(10)).toBeGreaterThan(10);
    expect(clampMidiToCarrierRange(120)).toBeLessThan(120);
  });
});
