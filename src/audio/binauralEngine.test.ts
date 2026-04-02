import { describe, expect, it } from 'vitest';

import {
  addTonePair,
  computeChannelFrequencies,
  computeTonePairSnapshot,
  removeTonePair,
  sanitizeNoiseConfig,
  sanitizeTonePair,
  updateTonePair,
} from './binauralEngine';

describe('computeChannelFrequencies', () => {
  it('splits the carrier frequency symmetrically', () => {
    expect(computeChannelFrequencies(220, 8)).toEqual({
      leftHz: 216,
      rightHz: 224,
    });
  });

  it('allows low-carrier experimental pairs while keeping channels non-negative', () => {
    expect(computeChannelFrequencies(43, 3)).toEqual({
      leftHz: 41.5,
      rightHz: 44.5,
    });
  });
});

describe('sanitizeTonePair', () => {
  it('fills missing values from defaults', () => {
    expect(sanitizeTonePair({ id: 'pair-a', carrierHz: 180 })).toEqual({
      id: 'pair-a',
      carrierHz: 180,
      beatHz: 10,
      gain: 1,
    });
  });

  it('clamps gain and carrier values into range', () => {
    expect(
      sanitizeTonePair({
        id: 'pair-b',
        carrierHz: 5,
        beatHz: 100,
        gain: 3,
      }),
    ).toEqual({
      id: 'pair-b',
      carrierHz: 20,
      beatHz: 40,
      gain: 1,
    });
  });
});

describe('pair list helpers', () => {
  it('addTonePair appends a new pair and returns its id', () => {
    const basePairs = [sanitizeTonePair({ id: 'base' })];
    const { pair, pairs } = addTonePair(
      basePairs,
      { carrierHz: 240, beatHz: 6, gain: 0.8 },
      () => 'new-id',
    );

    expect(pair).toMatchObject({
      id: 'new-id',
      carrierHz: 240,
      beatHz: 6,
      gain: 0.8,
    });
    expect(pairs).toHaveLength(2);
    expect(pairs[1]?.id).toBe('new-id');
  });

  it('removeTonePair leaves the last remaining pair intact', () => {
    const lonePair = [sanitizeTonePair({ id: 'only' })];

    expect(removeTonePair(lonePair, 'only')).toEqual(lonePair);
  });

  it('updateTonePair only updates the targeted pair', () => {
    const pairs = [
      sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 1 }),
      sanitizeTonePair({ id: 'b', carrierHz: 160, beatHz: 6, gain: 0.5 }),
    ];

    expect(updateTonePair(pairs, 'b', { beatHz: 4, gain: 0.25 })).toEqual([
      pairs[0],
      {
        id: 'b',
        carrierHz: 160,
        beatHz: 4,
        gain: 0.25,
      },
    ]);
  });
});

describe('snapshot helpers', () => {
  it('computeTonePairSnapshot reflects each pair independently', () => {
    expect(
      computeTonePairSnapshot(
        sanitizeTonePair({
          id: 'pair-x',
          carrierHz: 200,
          beatHz: 10,
          gain: 0.8,
        }),
      ),
    ).toEqual({
      id: 'pair-x',
      carrierHz: 200,
      beatHz: 10,
      gain: 0.8,
      leftHz: 195,
      rightHz: 205,
    });
  });
});

describe('sanitizeNoiseConfig', () => {
  it('clamps noise volume and preserves enabled state', () => {
    expect(
      sanitizeNoiseConfig({
        enabled: true,
        volume: 2,
      }),
    ).toEqual({
      enabled: true,
      volume: 1,
    });
  });
});
