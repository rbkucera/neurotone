import { describe, expect, it } from 'vitest';

import { sanitizeTonePair } from './binauralEngine';
import {
  classifyBand,
  computeBeatMap,
  computeEnvelope,
} from './visualization';

describe('classifyBand', () => {
  it('classifies standard brainwave bands', () => {
    expect(classifyBand(2)).toBe('delta');
    expect(classifyBand(6)).toBe('theta');
    expect(classifyBand(10)).toBe('alpha');
    expect(classifyBand(20)).toBe('beta');
    expect(classifyBand(40)).toBe('gamma');
    expect(classifyBand(140)).toBe('unknown');
  });
});

describe('computeBeatMap', () => {
  it('includes designed and emergent carrier-interference beats', () => {
    const layers = [
      sanitizeTonePair({ id: 'a', carrierHz: 90, beatHz: 1, gain: 1 }),
      sanitizeTonePair({ id: 'b', carrierHz: 80, beatHz: 27.6, gain: 0.8 }),
    ];

    const beatMap = computeBeatMap(layers);

    expect(
      beatMap.some(
        (entry) =>
          entry.type === 'designed' &&
          entry.frequencyHz === 1 &&
          entry.layerIds[0] === 'a',
      ),
    ).toBe(true);

    expect(
      beatMap.some(
        (entry) =>
          entry.type === 'carrier-interference' &&
          entry.frequencyHz === 10 &&
          entry.band === 'alpha',
      ),
    ).toBe(true);
  });

  it('includes second-order beat relationships for multiple layers', () => {
    const layers = [
      sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 1 }),
      sanitizeTonePair({ id: 'b', carrierHz: 160, beatHz: 6, gain: 1 }),
    ];

    const beatMap = computeBeatMap(layers);
    const labels = beatMap
      .filter((entry) => entry.type === 'second-order')
      .map((entry) => `${entry.label}:${entry.frequencyHz}`);

    expect(labels).toContain('Beat difference:4');
    expect(labels).toContain('Beat sum:16');
  });
});

describe('computeEnvelope', () => {
  it('returns normalized samples', () => {
    const layers = [
      sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 1 }),
      sanitizeTonePair({ id: 'b', carrierHz: 190, beatHz: 6, gain: 0.7 }),
    ];

    const samples = computeEnvelope(layers, 5, 128);
    const max = Math.max(...Array.from(samples, (sample) => Math.abs(sample)));

    expect(samples).toHaveLength(128);
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThan(0.1);
  });

  it('returns silence when there are no audible layers', () => {
    const samples = computeEnvelope(
      [sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 0 })],
      5,
      32,
    );

    expect(Array.from(samples)).toEqual(new Array(32).fill(0));
  });
});
