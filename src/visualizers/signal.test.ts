import { describe, expect, it } from 'vitest';

import { sanitizeTonePair } from '../audio/binauralEngine';
import {
  clamp01,
  computeSyntheticStft,
  sampleLogBands,
  synthesizeStereoSignal,
} from './signal';

describe('synthesizeStereoSignal', () => {
  it('is deterministic for the same input', () => {
    const pairs = [
      sanitizeTonePair({ id: 'voice-a', carrierHz: 196, beatHz: 2.8, gain: 0.7 }),
      sanitizeTonePair({ id: 'voice-b', carrierHz: 246.94, beatHz: 1.4, gain: 0.5 }),
    ];

    const first = synthesizeStereoSignal(pairs, {
      sampleCount: 256,
      windowSeconds: 5,
      centerTimeSeconds: 10.5,
      motionScale: 0.88,
    });
    const second = synthesizeStereoSignal(pairs, {
      sampleCount: 256,
      windowSeconds: 5,
      centerTimeSeconds: 10.5,
      motionScale: 0.88,
    });

    expect(Array.from(first.left)).toEqual(Array.from(second.left));
    expect(Array.from(first.right)).toEqual(Array.from(second.right));
    expect(Array.from(first.mono)).toEqual(Array.from(second.mono));
    expect(first.rms).toBeCloseTo(second.rms, 8);
  });
});

describe('computeSyntheticStft', () => {
  it('returns normalized finite magnitudes', () => {
    const pairs = [
      sanitizeTonePair({ id: 'voice-a', carrierHz: 220, beatHz: 3, gain: 0.9 }),
      sanitizeTonePair({ id: 'voice-b', carrierHz: 329.63, beatHz: 6, gain: 0.4 }),
    ];
    const signal = synthesizeStereoSignal(pairs, {
      sampleCount: 512,
      windowSeconds: 5,
      centerTimeSeconds: 12,
    });
    const stft = computeSyntheticStft(signal.mono, 96, 24);

    expect(stft.frameCount).toBeGreaterThan(0);
    expect(stft.binCount).toBeGreaterThan(0);
    expect(stft.magnitudes).toHaveLength(stft.frameCount * stft.binCount);
    expect(stft.magnitudes.every((value) => Number.isFinite(value))).toBe(true);
    expect(Math.max(...stft.magnitudes)).toBeLessThanOrEqual(1);
    expect(Math.max(...stft.magnitudes)).toBeGreaterThan(0.01);
  });
});

describe('sampleLogBands', () => {
  it('produces finite log-frequency band values', () => {
    const pairs = [
      sanitizeTonePair({ id: 'voice-a', carrierHz: 174.61, beatHz: 2, gain: 1 }),
    ];
    const signal = synthesizeStereoSignal(pairs, {
      sampleCount: 256,
      windowSeconds: 4,
      centerTimeSeconds: 8,
    });
    const stft = computeSyntheticStft(signal.mono, 80, 20);
    const bands = sampleLogBands(stft, 24);

    expect(bands.frameCount).toBe(stft.frameCount);
    expect(bands.bandCount).toBe(24);
    expect(bands.values).toHaveLength(stft.frameCount * 24);
    expect(bands.values.every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe('clamp01', () => {
  it('clamps intensity ranges to 0..1', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(3)).toBe(1);
  });
});

