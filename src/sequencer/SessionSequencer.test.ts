import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sanitizeTonePair } from '../audio/binauralEngine';
import { SessionSequencer } from './SessionSequencer';
import { createSessionDefinition, createSessionSegment } from './utils';

function createTestSession() {
  return createSessionDefinition({
    segments: [
      createSessionSegment({
        id: 'segment-1',
        label: 'One',
        holdDuration: 4,
        transitionDuration: 0,
        state: {
          pairs: [
            sanitizeTonePair({
              id: 'pair-1',
              carrierHz: 200,
              beatHz: 10,
              gain: 0.7,
            }),
          ],
          masterGain: 0.2,
          noise: {
            enabled: false,
            volume: 0.05,
            model: 'soft',
          },
        },
      }),
      createSessionSegment({
        id: 'segment-2',
        label: 'Two',
        holdDuration: 6,
        transitionDuration: 2,
        state: {
          pairs: [
            sanitizeTonePair({
              id: 'pair-1',
              carrierHz: 240,
              beatHz: 8,
              gain: 0.7,
            }),
          ],
          masterGain: 0.22,
          noise: {
            enabled: true,
            volume: 0.06,
            model: 'surf',
          },
        },
      }),
    ],
  });
}

function createMockEngine() {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setBaseParams: vi.fn(),
    setNoise: vi.fn(),
  };
}

describe('SessionSequencer', () => {
  let nowMs = 0;
  let rafCallbacks: Array<(timestamp: number) => void> = [];
  let timeoutCallbacks: Array<() => void> = [];
  let visibilityListeners = new Set<() => void>();
  let visibilityState: 'visible' | 'hidden' = 'visible';
  let requestAnimationFrameMock: ReturnType<typeof vi.fn>;
  let setTimeoutMock: ReturnType<typeof vi.fn>;

  const emitVisibilityChange = () => {
    visibilityListeners.forEach((listener) => listener());
  };

  beforeEach(() => {
    nowMs = 0;
    rafCallbacks = [];
    timeoutCallbacks = [];
    visibilityListeners = new Set();
    visibilityState = 'visible';

    requestAnimationFrameMock = vi.fn((callback: (timestamp: number) => void) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    setTimeoutMock = vi.fn((handler: unknown) => {
      if (typeof handler === 'function') {
        timeoutCallbacks.push(handler as () => void);
      }
      return timeoutCallbacks.length;
    });

    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.stubGlobal('window', {
      requestAnimationFrame: requestAnimationFrameMock,
      cancelAnimationFrame: vi.fn(),
      setTimeout: setTimeoutMock,
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (event: string, callback: unknown) => {
        if (event === 'visibilitychange' && typeof callback === 'function') {
          visibilityListeners.add(callback as () => void);
        }
      },
      removeEventListener: (event: string, callback: unknown) => {
        if (event === 'visibilitychange' && typeof callback === 'function') {
          visibilityListeners.delete(callback as () => void);
        }
      },
      dispatchEvent: (event: { type?: string }) => {
        if (event.type === 'visibilitychange') {
          visibilityListeners.forEach((listener) => listener());
        }
        return true;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves a seeked idle position when playback starts', async () => {
    const engine = createMockEngine();
    const sequencer = new SessionSequencer(engine as never);

    sequencer.load(createTestSession());
    sequencer.seekToSegment(1);

    const beforePlay = sequencer.getPlaybackState();
    expect(beforePlay.currentSegmentIndex).toBe(1);
    expect(beforePlay.totalElapsed).toBe(4);

    await sequencer.play();

    const playingState = sequencer.getPlaybackState();
    expect(playingState.status).toBe('playing');
    expect(playingState.currentSegmentIndex).toBe(1);
    expect(playingState.totalElapsed).toBe(4);
    expect(engine.start).toHaveBeenCalledTimes(1);
    await sequencer.stop();
  });

  it('awaits engine stop when pausing playback', async () => {
    const engine = createMockEngine();
    const sequencer = new SessionSequencer(engine as never);

    sequencer.load(createTestSession());
    await sequencer.play();
    await sequencer.pause();

    expect(sequencer.getPlaybackState().status).toBe('paused');
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it('resets to the first segment when stopped', async () => {
    const engine = createMockEngine();
    const sequencer = new SessionSequencer(engine as never);

    sequencer.load(createTestSession());
    sequencer.seekToSegment(1);
    await sequencer.stop();

    const stoppedState = sequencer.getPlaybackState();
    expect(stoppedState.status).toBe('idle');
    expect(stoppedState.currentSegmentIndex).toBe(0);
    expect(stoppedState.totalElapsed).toBe(0);
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it('uses timeout scheduling when playback starts in a hidden tab', async () => {
    const engine = createMockEngine();
    const sequencer = new SessionSequencer(engine as never);

    sequencer.load(createTestSession());
    visibilityState = 'hidden';
    await sequencer.play();

    expect(requestAnimationFrameMock).not.toHaveBeenCalled();
    expect(setTimeoutMock).toHaveBeenCalled();
    await sequencer.stop();
  });

  it('switches scheduler modes when tab visibility changes during playback', async () => {
    const engine = createMockEngine();
    const sequencer = new SessionSequencer(engine as never);

    sequencer.load(createTestSession());
    visibilityState = 'visible';
    await sequencer.play();

    expect(requestAnimationFrameMock).toHaveBeenCalled();
    const rafCallsBeforeHidden = requestAnimationFrameMock.mock.calls.length;

    visibilityState = 'hidden';
    emitVisibilityChange();

    expect(setTimeoutMock).toHaveBeenCalled();

    visibilityState = 'visible';
    emitVisibilityChange();

    const rafCallsAfterVisible = requestAnimationFrameMock.mock.calls.length;
    expect(rafCallsAfterVisible).toBeGreaterThan(rafCallsBeforeHidden);
    await sequencer.stop();
  });

  it('continues elapsed progression while hidden using timeout ticks', async () => {
    const engine = createMockEngine();
    const sequencer = new SessionSequencer(engine as never);

    sequencer.load(createTestSession());
    visibilityState = 'hidden';
    await sequencer.play();

    const firstTimeout = timeoutCallbacks.shift();
    expect(firstTimeout).toBeDefined();
    nowMs = 1500;
    firstTimeout?.();

    let state = sequencer.getPlaybackState();
    expect(state.totalElapsed).toBeCloseTo(1.5, 3);
    expect(state.currentSegmentIndex).toBe(0);

    const secondTimeout = timeoutCallbacks.shift();
    expect(secondTimeout).toBeDefined();
    nowMs = 5200;
    secondTimeout?.();

    state = sequencer.getPlaybackState();
    expect(state.totalElapsed).toBeCloseTo(5.2, 3);
    expect(state.currentSegmentIndex).toBe(1);
    await sequencer.stop();
  });

  it('loops a selected segment target without transition interpolation', async () => {
    const engine = createMockEngine();
    const sequencer = new SessionSequencer(engine as never);
    const session = createSessionDefinition({
      loop: true,
      segments: [
        createSessionSegment({
          id: 'segment-1',
          holdDuration: 4,
          transitionDuration: 0,
          state: {
            pairs: [
              sanitizeTonePair({
                id: 'pair-1',
                carrierHz: 200,
                beatHz: 10,
                gain: 0.7,
              }),
            ],
            masterGain: 0.2,
            noise: {
              enabled: false,
              volume: 0.05,
              model: 'soft',
            },
          },
          overrides: [],
        }),
        createSessionSegment({
          id: 'segment-2',
          holdDuration: 6,
          transitionDuration: 2,
          state: {
            pairs: [
              sanitizeTonePair({
                id: 'pair-1',
                carrierHz: 260,
                beatHz: 8,
                gain: 0.7,
              }),
            ],
            masterGain: 0.18,
            noise: {
              enabled: true,
              volume: 0.08,
              model: 'brown',
            },
          },
          overrides: [
            {
              id: 'segment-2-master',
              label: 'Master',
              target: 'masterGain',
              interpolation: 'linear',
              enabled: true,
              keyframes: [
                { id: 'k1', time: 0, value: 0.2 },
                { id: 'k2', time: 8, value: 0.4 },
              ],
            },
          ],
        }),
      ],
    });

    sequencer.load(session);
    sequencer.setPlaybackTarget({ type: 'segment-loop', segmentId: 'segment-2' });
    await sequencer.play();

    let state = sequencer.getPlaybackState();
    expect(state.currentSegmentIndex).toBe(1);
    expect(state.currentSegmentPhase).toBe('holding');
    expect(state.totalDuration).toBeCloseTo(8, 6);

    const firstTick = rafCallbacks.shift();
    expect(firstTick).toBeDefined();
    nowMs = 9500;
    firstTick?.(nowMs);

    state = sequencer.getPlaybackState();
    expect(state.currentSegmentIndex).toBe(1);
    expect(state.currentSegmentPhase).toBe('holding');
    expect(state.totalElapsed).toBeCloseTo(1.5, 3);

    const latestBaseCall = engine.setBaseParams.mock.calls.at(-1)?.[0];
    expect(latestBaseCall?.pairs?.[0]?.carrierHz).toBeCloseTo(260, 6);
    expect(latestBaseCall?.masterGain).toBeCloseTo(0.2375, 3);
    await sequencer.stop();
  });

  it('falls back to session playback target when segment-loop id is missing', () => {
    const engine = createMockEngine();
    const sequencer = new SessionSequencer(engine as never);

    sequencer.load(createTestSession());
    sequencer.setPlaybackTarget({ type: 'segment-loop', segmentId: 'missing' });

    const state = sequencer.getPlaybackState();
    expect(state.currentSegmentIndex).toBe(0);
    expect(state.totalDuration).toBeCloseTo(12, 6);
  });
});
