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
  beforeEach(() => {
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
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
});
