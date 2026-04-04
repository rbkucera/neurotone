import { describe, expect, it } from 'vitest';

import { sanitizeTonePair } from '../audio/binauralEngine';
import {
  applySegmentOverrides,
  createSessionDefinition,
  createSessionSegment,
  interpolateSoundStates,
  rebuildSessionAutomationLanes,
  totalSessionDuration,
  resolveSessionMoment,
} from './utils';

describe('sequencer utils', () => {
  it('interpolates matching and removed pairs cleanly', () => {
    const from = {
      pairs: [sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 0.8 })],
      masterGain: 0.2,
      noise: {
        enabled: false,
        volume: 0.04,
        model: 'soft' as const,
      },
    };
    const to = {
      pairs: [sanitizeTonePair({ id: 'b', carrierHz: 300, beatHz: 6, gain: 0.5 })],
      masterGain: 0.25,
      noise: {
        enabled: true,
        volume: 0.05,
        model: 'surf' as const,
      },
    };

    const result = interpolateSoundStates(from, to, 0.5);

    expect(result.pairs).toHaveLength(2);
    expect(result.masterGain).toBeCloseTo(0.225, 6);
  });

  it('applies segment override lane values against local segment time', () => {
    const state = applySegmentOverrides(
      {
        pairs: [sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 0.8 })],
        masterGain: 0.2,
        noise: {
          enabled: true,
          volume: 0.05,
          model: 'soft',
        },
      },
      [
        {
          id: 'lane-1',
          label: 'Master',
          target: 'masterGain',
          interpolation: 'linear',
          enabled: true,
          keyframes: [
            { id: 'k1', time: 0, value: 0.2 },
            { id: 'k2', time: 10, value: 0.4 },
          ],
        },
      ],
      5,
    );

    expect(state.masterGain).toBeCloseTo(0.3, 6);
  });

  it('resolves session moments using the active segment overrides', () => {
    const session = createSessionDefinition({
      segments: [
        createSessionSegment({
          id: 'one',
          holdDuration: 6,
          transitionDuration: 0,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 0.8 })],
            masterGain: 0.2,
            noise: {
              enabled: true,
              volume: 0.05,
              model: 'soft',
            },
          },
          overrides: [],
        }),
        createSessionSegment({
          id: 'two',
          holdDuration: 6,
          transitionDuration: 2,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 240, beatHz: 8, gain: 0.8 })],
            masterGain: 0.22,
            noise: {
              enabled: true,
              volume: 0.05,
              model: 'soft',
            },
          },
          overrides: [
            {
              id: 'segment-two-master',
              label: 'Master volume',
              target: 'masterGain',
              interpolation: 'linear',
              enabled: true,
              keyframes: [
                { id: 'k1', time: 0, value: 0.1 },
                { id: 'k2', time: 8, value: 0.34 },
              ],
            },
          ],
        }),
      ],
    });

    const moment = resolveSessionMoment(session, 7);

    expect(moment.playbackState.status).toBe('playing');
    expect(moment.playbackState.currentSegmentIndex).toBe(1);
    expect(moment.soundState.masterGain).toBeGreaterThan(0.1);
    expect(moment.soundState.masterGain).toBeLessThan(0.34);
  });

  it('treats exact segment boundaries as the start of the next segment', () => {
    const session = createSessionDefinition({
      segments: [
        createSessionSegment({
          id: 'one',
          holdDuration: 4,
          transitionDuration: 0,
          overrides: [],
        }),
        createSessionSegment({
          id: 'two',
          holdDuration: 6,
          transitionDuration: 2,
          overrides: [],
        }),
      ],
    });

    const moment = resolveSessionMoment(session, 4);

    expect(moment.playbackState.currentSegmentIndex).toBe(1);
    expect(moment.playbackState.currentSegmentPhase).toBe('transitioning');
    expect(moment.playbackState.elapsedInPhase).toBe(0);
  });

  it('drops legacy global automation lanes during session rebuild', () => {
    const session = rebuildSessionAutomationLanes(
      createSessionDefinition({
        segments: [
          createSessionSegment({
            state: {
              pairs: [sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 0.8 })],
              masterGain: 0.2,
              noise: {
                enabled: true,
                volume: 0.05,
                model: 'soft',
              },
            },
            overrides: [],
          }),
        ],
        automationLanes: [
          {
            id: 'legacy-lane',
            label: 'Legacy',
            target: 'masterGain',
            interpolation: 'linear',
            enabled: true,
            source: 'custom',
            keyframes: [{ id: 'k1', time: 0, value: 0.15 }],
          },
        ],
      }),
    );

    expect(session.automationLanes).toEqual([]);
  });

  it('uses segment one transition for loop wrap crossfade', () => {
    const session = createSessionDefinition({
      loop: true,
      segments: [
        createSessionSegment({
          id: 'first',
          holdDuration: 4,
          transitionDuration: 3,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 180, beatHz: 8, gain: 0.7 })],
            masterGain: 0.12,
            noise: { enabled: false, volume: 0.03, model: 'soft' },
          },
          overrides: [],
        }),
        createSessionSegment({
          id: 'second',
          holdDuration: 5,
          transitionDuration: 2,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 260, beatHz: 10, gain: 0.7 })],
            masterGain: 0.42,
            noise: { enabled: true, volume: 0.08, model: 'brown' },
          },
          overrides: [],
        }),
      ],
    });

    const total = totalSessionDuration(session);
    const moment = resolveSessionMoment(session, total - 1.5);

    expect(moment.playbackState.currentSegmentIndex).toBe(0);
    expect(moment.playbackState.currentSegmentPhase).toBe('transitioning');
    expect(moment.playbackState.elapsedInPhase).toBeCloseTo(1.5, 6);
    expect(moment.soundState.masterGain).toBeGreaterThan(0.12);
    expect(moment.soundState.masterGain).toBeLessThan(0.42);
  });

  it('samples segment one overrides with local transition time during loop wrap', () => {
    const session = createSessionDefinition({
      loop: true,
      segments: [
        createSessionSegment({
          id: 'first',
          holdDuration: 4,
          transitionDuration: 3,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 180, beatHz: 8, gain: 0.7 })],
            masterGain: 0.12,
            noise: { enabled: false, volume: 0.03, model: 'soft' },
          },
          overrides: [
            {
              id: 'first-master',
              label: 'Master',
              target: 'masterGain',
              interpolation: 'linear',
              enabled: true,
              keyframes: [
                { id: 'k1', time: 0, value: 0.2 },
                { id: 'k2', time: 3, value: 0.8 },
              ],
            },
          ],
        }),
        createSessionSegment({
          id: 'second',
          holdDuration: 5,
          transitionDuration: 2,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 260, beatHz: 10, gain: 0.7 })],
            masterGain: 0.42,
            noise: { enabled: true, volume: 0.08, model: 'brown' },
          },
          overrides: [],
        }),
      ],
    });

    const total = totalSessionDuration(session);
    const moment = resolveSessionMoment(session, total - 1.5);

    expect(moment.playbackState.currentSegmentIndex).toBe(0);
    expect(moment.playbackState.currentSegmentPhase).toBe('transitioning');
    expect(moment.soundState.masterGain).toBeCloseTo(0.5, 6);
  });

  it('does not force wrap transition when first segment transition is zero', () => {
    const session = createSessionDefinition({
      loop: true,
      segments: [
        createSessionSegment({
          id: 'first',
          holdDuration: 4,
          transitionDuration: 0,
          overrides: [],
        }),
        createSessionSegment({
          id: 'second',
          holdDuration: 5,
          transitionDuration: 2,
          overrides: [],
        }),
      ],
    });

    const total = totalSessionDuration(session);
    const moment = resolveSessionMoment(session, total - 0.2);

    expect(moment.playbackState.currentSegmentIndex).toBe(1);
    expect(moment.playbackState.currentSegmentPhase).toBe('holding');
  });

  it('remains stable for single-segment loop sessions', () => {
    const session = createSessionDefinition({
      loop: true,
      segments: [
        createSessionSegment({
          id: 'solo',
          holdDuration: 6,
          transitionDuration: 4,
          overrides: [],
        }),
      ],
    });

    const moment = resolveSessionMoment(session, 5.5);

    expect(moment.playbackState.currentSegmentIndex).toBe(0);
    expect(moment.playbackState.currentSegmentPhase).toBe('holding');
  });
});
