import { describe, expect, it } from 'vitest';

import { sanitizeTonePair } from './audio/binauralEngine';
import {
  createInitialShareableState,
  decodeShareableState,
  encodeShareableState,
  normalizeShareableState,
} from './sessionState';

describe('normalizeShareableState', () => {
  it('ensures there is always at least one session segment', () => {
    const state = normalizeShareableState({});

    expect(state.session.segments).toHaveLength(1);
  });
});

describe('share state encoding', () => {
  it('round-trips audio session state through the v5 compressed URL hash format', () => {
    const original = normalizeShareableState({
      presetId: 'clear-focus',
      mode: 'timeline',
      composer: {
        label: 'My plan',
        source: 'Am Fmaj7 C G',
        stepDuration: 6,
        intent: 'alpha',
      },
      session: {
        id: 'session-1',
        label: 'My session',
        loop: true,
        metadata: {
          source: 'generated',
          intent: 'alpha',
          input: 'Am Fmaj7 C G',
        },
        segments: [
          {
            id: 'segment-1',
            label: 'Start',
            holdDuration: 6,
            transitionDuration: 0,
            overrides: [],
            state: {
              pairs: [
                sanitizeTonePair({
                  id: 'a',
                  carrierHz: 200,
                  beatHz: 10,
                  gain: 0.8,
                }),
              ],
              masterGain: 0.22,
              noise: {
                enabled: true,
                volume: 0.05,
                model: 'surf',
              },
            },
          },
        ],
        automationLanes: [],
      },
    });

    const decoded = decodeShareableState(encodeShareableState(original));

    expect(decoded).not.toBeNull();
    expect(decoded?.presetId).toBeNull();
    expect(decoded?.mode).toBe('timeline');
    expect(decoded?.session.segments).toHaveLength(1);
    expect(decoded?.session.segments[0]?.state.pairs[0]).toMatchObject({
      carrierHz: 200,
      beatHz: 10,
      gain: 0.8,
    });
    expect(decoded?.session.segments[0]?.state.noise).toEqual({
      enabled: true,
      volume: 0.05,
      model: 'surf',
    });
    expect(decoded?.composer).toEqual({
      label: 'Generated session',
      source: 'Am Fmaj7 C G',
      stepDuration: 8,
      intent: 'alpha',
    });
  });

  it('hard-cuts old formats and accepts only v5 compressed payloads', () => {
    expect(
      decodeShareableState(
        '#v=4&state=%7B%22mode%22%3A%22timeline%22%7D',
      ),
    ).toBeNull();
    expect(
      decodeShareableState(
        '#preset=clear-focus&pairs=200~10~0.8|43~3~0.4&master=0.22&noiseEnabled=1&noiseVolume=0.05&noiseModel=surf',
      ),
    ).toBeNull();
  });

  it('returns null for malformed v5 compressed payloads', () => {
    expect(decodeShareableState('#v=5')).toBeNull();
    expect(decodeShareableState('#v=5&z=bad-payload')).toBeNull();
  });

  it('produces materially shorter URLs than v4 url-encoded JSON', () => {
    const original = normalizeShareableState({
      mode: 'timeline',
      session: {
        id: 'session-1',
        label: 'Long session',
        loop: true,
        metadata: {
          source: 'generated',
          intent: 'alpha',
          input: 'D G A F',
        },
        segments: [
          {
            id: 'segment-1',
            label: 'F',
            holdDuration: 22,
            transitionDuration: 0,
            state: {
              pairs: [
                sanitizeTonePair({
                  id: 'voice-1',
                  carrierHz: 174.61411571650194,
                  beatHz: 1.95,
                  gain: 0.82,
                }),
                sanitizeTonePair({
                  id: 'voice-2',
                  carrierHz: 220,
                  beatHz: 2.4,
                  gain: 0.64,
                }),
              ],
              masterGain: 0.18,
              noise: {
                enabled: true,
                volume: 0.055,
                model: 'brown',
              },
            },
            overrides: [
              {
                id: 'override-1',
                label: 'Carrier (Layer 1)',
                target: 'pair:voice-1.carrierHz',
                interpolation: 'linear',
                enabled: true,
                keyframes: [
                  { id: 'k1', time: 0, value: 174.61411571650194 },
                  { id: 'k2', time: 9.6, value: 261.6255653005986 },
                ],
              },
            ],
          },
          {
            id: 'segment-2',
            label: 'F copy',
            holdDuration: 22,
            transitionDuration: 4,
            state: {
              pairs: [
                sanitizeTonePair({
                  id: 'voice-1',
                  carrierHz: 261.6255653005986,
                  beatHz: 1.95,
                  gain: 0.82,
                }),
                sanitizeTonePair({
                  id: 'voice-2',
                  carrierHz: 261.6255653005986,
                  beatHz: 2.4,
                  gain: 0.64,
                }),
              ],
              masterGain: 0.18,
              noise: {
                enabled: true,
                volume: 0.055,
                model: 'brown',
              },
            },
            overrides: [],
          },
        ],
        automationLanes: [],
      },
    });

    const encodedV5 = encodeShareableState(original);
    const encodedV4 = new URLSearchParams({
      v: '4',
      state: JSON.stringify(normalizeShareableState(original)),
    }).toString();

    expect(encodedV5.length).toBeLessThan(encodedV4.length);
  });

  it('creates a default timeline when no persisted state is present', () => {
    const state = createInitialShareableState();

    expect(state.mode).toBe('manual');
    expect(state.session.segments).toHaveLength(1);
  });
});
