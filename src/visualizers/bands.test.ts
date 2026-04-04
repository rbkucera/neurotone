import { describe, expect, it } from 'vitest';

import type { BeatEntry } from '../audio/visualization';
import {
  advanceBandActivity,
  createEmptyBandActivity,
  visualizerBandOrder,
} from './bands';

describe('visualizerBandOrder', () => {
  it('returns stable brainwave ordering', () => {
    expect(visualizerBandOrder()).toEqual([
      'delta',
      'theta',
      'alpha',
      'beta',
      'gamma',
    ]);
  });
});

describe('advanceBandActivity', () => {
  it('weights designed beats above second-order beats and smooths over time', () => {
    const entries: BeatEntry[] = [
      {
        label: 'Designed alpha',
        frequencyHz: 10,
        band: 'alpha',
        type: 'designed',
        layerIds: ['a'],
      },
      {
        label: 'Second-order beta',
        frequencyHz: 18,
        band: 'beta',
        type: 'second-order',
        layerIds: ['b'],
      },
    ];

    const first = advanceBandActivity(createEmptyBandActivity(), entries, 0.5);
    expect(first.levels.alpha).toBeGreaterThan(first.levels.beta);
    expect(first.dominant).toBe('alpha');

    const second = advanceBandActivity(first, entries, 0.5);
    expect(second.levels.alpha).toBeGreaterThan(first.levels.alpha);
  });

  it('returns no dominant band when activity is negligible', () => {
    const result = advanceBandActivity(createEmptyBandActivity(), [], 0.2);
    expect(result.dominant).toBe(null);
    expect(result.activeBands).toHaveLength(0);
  });
});

