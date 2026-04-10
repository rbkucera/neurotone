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
      gain: 0.2,
      noise: {
        enabled: false,
        volume: 0.04,
        model: 'soft' as const,
      },
    };
    const to = {
      pairs: [sanitizeTonePair({ id: 'b', carrierHz: 300, beatHz: 6, gain: 0.5 })],
      gain: 0.25,
      noise: {
        enabled: true,
        volume: 0.05,
        model: 'surf' as const,
      },
    };

    const result = interpolateSoundStates(from, to, 0.5);

    expect(result.pairs).toHaveLength(2);
    expect(result.gain).toBeCloseTo(0.225, 6);
  });

  it('applies segment override lane values against local segment time', () => {
    const state = applySegmentOverrides(
      {
        pairs: [sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 0.8 })],
        gain: 0.2,
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
          target: 'gain',
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

    expect(state.gain).toBeCloseTo(0.3, 6);
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
            gain: 0.2,
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
            gain: 0.22,
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
              target: 'gain',
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
    expect(moment.soundState.gain).toBeGreaterThan(0.1);
    expect(moment.soundState.gain).toBeLessThan(0.34);
  });

  it('uses resolved end state of previous segment during transition', () => {
    const session = createSessionDefinition({
      segments: [
        createSessionSegment({
          id: 'one',
          holdDuration: 10,
          transitionDuration: 0,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 200, beatHz: 10, gain: 0.8 })],
            gain: 0.5,
            noise: { enabled: false, volume: 0, model: 'soft' },
          },
          overrides: [
            {
              id: 'carrier-ramp',
              label: 'Carrier ramp',
              target: 'pair:a.carrierHz',
              interpolation: 'linear',
              enabled: true,
              keyframes: [
                { id: 'k1', time: 0, value: 200 },
                { id: 'k2', time: 10, value: 400 },
              ],
            },
          ],
        }),
        createSessionSegment({
          id: 'two',
          holdDuration: 10,
          transitionDuration: 4,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 300, beatHz: 10, gain: 0.8 })],
            gain: 0.5,
            noise: { enabled: false, volume: 0, model: 'soft' },
          },
          overrides: [],
        }),
      ],
    });

    // Segment one ends at t=10 with carrierHz override at 400.
    // Segment two transition runs t=10..14. At t=12, progress=0.5.
    // Should interpolate 400→300 = 350, not 200→300 = 250.
    const moment = resolveSessionMoment(session, 12);

    expect(moment.playbackState.currentSegmentIndex).toBe(1);
    expect(moment.playbackState.currentSegmentPhase).toBe('transitioning');

    const pair = moment.soundState.pairs.find((p) => p.id === 'a');
    expect(pair).toBeDefined();
    expect(pair!.carrierHz).toBeCloseTo(350, 0);
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
              gain: 0.2,
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
            target: 'gain',
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
            gain: 0.12,
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
            gain: 0.42,
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
    expect(moment.soundState.gain).toBeGreaterThan(0.12);
    expect(moment.soundState.gain).toBeLessThan(0.42);
  });

  it('interpolates between resolved end of last and resolved start of first during loop wrap', () => {
    const session = createSessionDefinition({
      loop: true,
      segments: [
        createSessionSegment({
          id: 'first',
          holdDuration: 4,
          transitionDuration: 3,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 180, beatHz: 8, gain: 0.7 })],
            gain: 0.12,
            noise: { enabled: false, volume: 0.03, model: 'soft' },
          },
          overrides: [
            {
              id: 'first-master',
              label: 'Master',
              target: 'gain',
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
            gain: 0.42,
            noise: { enabled: true, volume: 0.08, model: 'brown' },
          },
          overrides: [],
        }),
      ],
    });

    // Total=11. wrapTransitionDuration=3. wrapTransitionStart=8.
    // At t=9.5: localTransitionTime=1.5, progress=0.5.
    // Last segment (second) has no overrides, end state gain=0.42.
    // First segment override at time=0 gives gain=0.2.
    // Interpolated gain at progress=0.5: 0.42 + (0.2-0.42)*0.5 = 0.31.
    const total = totalSessionDuration(session);
    const moment = resolveSessionMoment(session, total - 1.5);

    expect(moment.playbackState.currentSegmentIndex).toBe(0);
    expect(moment.playbackState.currentSegmentPhase).toBe('transitioning');
    expect(moment.soundState.gain).toBeCloseTo(0.31, 1);
  });

  it('uses resolved end state of last segment during loop-wrap transition', () => {
    const session = createSessionDefinition({
      loop: true,
      segments: [
        createSessionSegment({
          id: 'first',
          holdDuration: 4,
          transitionDuration: 2,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 180, beatHz: 8, gain: 0.7 })],
            gain: 0.3,
            noise: { enabled: false, volume: 0, model: 'soft' },
          },
          overrides: [],
        }),
        createSessionSegment({
          id: 'second',
          holdDuration: 6,
          transitionDuration: 2,
          state: {
            pairs: [sanitizeTonePair({ id: 'a', carrierHz: 260, beatHz: 10, gain: 0.7 })],
            gain: 0.5,
            noise: { enabled: false, volume: 0, model: 'soft' },
          },
          overrides: [
            {
              id: 'carrier-ramp',
              label: 'Carrier ramp',
              target: 'pair:a.carrierHz',
              interpolation: 'linear',
              enabled: true,
              keyframes: [
                { id: 'k1', time: 0, value: 260 },
                { id: 'k2', time: 8, value: 500 },
              ],
            },
          ],
        }),
      ],
    });

    // First window: transitionStart=0, holdStart=0, end=4.
    // Second window: transitionStart=4, holdStart=6, end=12.
    // Total=12. wrapTransitionDuration=2, wrapTransitionStart=10.
    // Last segment localTime at end: 12-4=8. Override at t=8: carrierHz=500.
    // At t=11: localTransitionTime=1, progress=0.5.
    // Should interpolate 500→180 = 340, not 260→180 = 220.
    const moment = resolveSessionMoment(session, 11);

    expect(moment.playbackState.currentSegmentIndex).toBe(0);
    expect(moment.playbackState.currentSegmentPhase).toBe('transitioning');

    const pair = moment.soundState.pairs.find((p) => p.id === 'a');
    expect(pair).toBeDefined();
    expect(pair!.carrierHz).toBeCloseTo(340, 0);
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
