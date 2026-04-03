import type { BinauralEngine } from '../audio/binauralEngine';
import {
  type SessionDefinition,
  type SessionPlaybackState,
  type SessionSegment,
} from './types';
import {
  createSessionDefinition,
  createSessionSegment,
  resolveSessionMoment,
  rebuildSessionAutomationLanes,
  totalSessionDuration,
} from './utils';

function createId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export class SessionSequencer {
  private session: SessionDefinition = rebuildSessionAutomationLanes(
    createSessionDefinition(),
  );

  private playbackState: SessionPlaybackState = {
    status: 'idle',
    currentSegmentIndex: 0,
    currentSegmentPhase: 'holding',
    elapsedInPhase: 0,
    totalElapsed: 0,
    totalDuration: totalSessionDuration(this.session),
  };

  private animationFrameId: number | null = null;

  private tickSubscribers = new Set<(state: SessionPlaybackState) => void>();

  private segmentSubscribers = new Set<
    (index: number, segment: SessionSegment) => void
  >();

  private startedAtMs = 0;

  private pausedAtSeconds = 0;

  private lastSegmentIndex = -1;

  constructor(private readonly engine: BinauralEngine) {}

  load(session: SessionDefinition): void {
    this.cancelTick();
    this.session = rebuildSessionAutomationLanes(createSessionDefinition(session));
    this.pausedAtSeconds = 0;
    this.lastSegmentIndex = -1;
    this.playbackState = {
      ...this.playbackState,
      status: 'idle',
      currentSegmentIndex: 0,
      currentSegmentPhase: 'holding',
      elapsedInPhase: 0,
      totalElapsed: 0,
      totalDuration: totalSessionDuration(this.session),
    };
    this.applySoundState(this.session.segments[0]?.state);
    this.notifyTick();
  }

  replaceSession(session: SessionDefinition): void {
    const nextSession = rebuildSessionAutomationLanes(
      createSessionDefinition(session),
    );
    const preservedElapsed =
      this.playbackState.status === 'playing' || this.playbackState.status === 'paused'
        ? this.playbackState.totalElapsed
        : 0;

    this.session = nextSession;
    this.playbackState.totalDuration = totalSessionDuration(this.session);

    if (this.playbackState.status === 'idle') {
      this.applySoundState(this.session.segments[0]?.state);
      this.notifyTick();
      return;
    }

    const effectiveElapsed =
      this.session.loop && this.playbackState.totalDuration > 0
        ? preservedElapsed % this.playbackState.totalDuration
        : Math.min(preservedElapsed, this.playbackState.totalDuration);

    this.pausedAtSeconds = effectiveElapsed;
    if (this.playbackState.status === 'playing') {
      this.startedAtMs = performance.now() - effectiveElapsed * 1000;
    }

    const moment = resolveSessionMoment(this.session, effectiveElapsed);
    this.applySoundState(moment.soundState);
    this.playbackState = {
      ...moment.playbackState,
      status: this.playbackState.status,
    };
    this.lastSegmentIndex = -1;
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    this.notifyTick();
  }

  getSession(): SessionDefinition {
    return this.session;
  }

  async play(): Promise<void> {
    if (this.playbackState.status === 'paused') {
      await this.resume();
      return;
    }

    const startFromSeconds =
      this.playbackState.status === 'complete'
        ? 0
        : Math.max(0, this.playbackState.totalElapsed);

    this.pausedAtSeconds = startFromSeconds;
    this.startedAtMs = performance.now() - startFromSeconds * 1000;
    const moment = resolveSessionMoment(this.session, startFromSeconds);
    this.applySoundState(moment.soundState);
    this.playbackState = {
      ...moment.playbackState,
      status: 'playing',
    };
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    await this.engine.start();
    this.notifyTick();
    this.scheduleTick();
  }

  async pause(): Promise<void> {
    if (this.playbackState.status !== 'playing') {
      return;
    }

    this.pausedAtSeconds = this.playbackState.totalElapsed;
    this.playbackState.status = 'paused';
    this.cancelTick();
    await this.engine.stop();
    this.notifyTick();
  }

  async resume(): Promise<void> {
    if (this.playbackState.status !== 'paused') {
      return;
    }

    this.startedAtMs = performance.now() - this.pausedAtSeconds * 1000;
    const moment = resolveSessionMoment(this.session, this.pausedAtSeconds);
    this.applySoundState(moment.soundState);
    await this.engine.start();
    this.playbackState.status = 'playing';
    this.notifyTick();
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    this.cancelTick();
    this.pausedAtSeconds = 0;
    this.lastSegmentIndex = -1;
    this.playbackState = {
      ...this.playbackState,
      status: 'idle',
      currentSegmentIndex: 0,
      currentSegmentPhase: 'holding',
      elapsedInPhase: 0,
      totalElapsed: 0,
      totalDuration: totalSessionDuration(this.session),
    };
    await this.engine.stop();
    this.applySoundState(this.session.segments[0]?.state);
    this.notifySegment(0);
    this.notifyTick();
  }

  seekToSegment(index: number): void {
    const nextIndex = Math.min(
      this.session.segments.length - 1,
      Math.max(0, index),
    );
    const time = this.session.segments
      .slice(0, nextIndex)
      .reduce((total, segment, segmentIndex) => {
        return (
          total +
          segment.holdDuration +
          (segmentIndex === 0 ? 0 : segment.transitionDuration)
        );
      }, 0);

    this.pausedAtSeconds = time;
    this.startedAtMs = performance.now() - time * 1000;
    const moment = resolveSessionMoment(this.session, time);
    this.applySoundState(moment.soundState);
    this.playbackState = {
      ...moment.playbackState,
      status:
        this.playbackState.status === 'playing'
          ? 'playing'
          : this.playbackState.status === 'paused'
            ? 'paused'
            : 'idle',
    };
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    this.notifyTick();
  }

  getPlaybackState(): SessionPlaybackState {
    return this.playbackState;
  }

  onTick(callback: (state: SessionPlaybackState) => void): () => void {
    this.tickSubscribers.add(callback);
    return () => this.tickSubscribers.delete(callback);
  }

  onSegmentChange(
    callback: (index: number, segment: SessionSegment) => void,
  ): () => void {
    this.segmentSubscribers.add(callback);
    return () => this.segmentSubscribers.delete(callback);
  }

  addSegment(segment: Partial<SessionSegment>, afterIndex?: number): string {
    const nextSegment = createSessionSegment(segment);
    const insertAt =
      afterIndex === undefined
        ? this.session.segments.length
        : Math.max(0, Math.min(this.session.segments.length, afterIndex + 1));

    const segments = [...this.session.segments];
    segments.splice(insertAt, 0, nextSegment);
    this.session = createSessionDefinition({
      ...this.session,
      segments,
    });
    this.playbackState.totalDuration = totalSessionDuration(this.session);
    this.notifyTick();
    return nextSegment.id;
  }

  removeSegment(id: string): void {
    if (this.session.segments.length <= 1) {
      return;
    }

    this.session = createSessionDefinition({
      ...this.session,
      segments: this.session.segments.filter((segment) => segment.id !== id),
    });
    this.playbackState.totalDuration = totalSessionDuration(this.session);
    this.notifyTick();
  }

  updateSegment(id: string, patch: Partial<SessionSegment>): void {
    this.session = createSessionDefinition({
      ...this.session,
      segments: this.session.segments.map((segment) =>
        segment.id === id ? createSessionSegment({ ...segment, ...patch }) : segment,
      ),
    });
    this.playbackState.totalDuration = totalSessionDuration(this.session);
    this.notifyTick();
  }

  reorderSegments(orderedIds: string[]): void {
    const segmentMap = new Map(this.session.segments.map((segment) => [segment.id, segment]));
    const reordered = orderedIds
      .map((id) => segmentMap.get(id))
      .filter((segment): segment is SessionSegment => Boolean(segment));

    if (reordered.length !== this.session.segments.length) {
      return;
    }

    this.session = createSessionDefinition({
      ...this.session,
      segments: reordered,
    });
    this.notifyTick();
  }

  private scheduleTick(): void {
    this.cancelTick();
    this.animationFrameId = window.requestAnimationFrame(this.handleTick);
  }

  private cancelTick(): void {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private readonly handleTick = async (timestampMs: number): Promise<void> => {
    const elapsedSeconds = Math.max(0, (timestampMs - this.startedAtMs) / 1000);
    const totalDuration = totalSessionDuration(this.session);

    if (!this.session.loop && elapsedSeconds >= totalDuration) {
      const finalMoment = resolveSessionMoment(this.session, totalDuration);
      this.applySoundState(finalMoment.soundState);
      this.playbackState = {
        ...finalMoment.playbackState,
        status: 'complete',
      };
      this.notifySegment(finalMoment.playbackState.currentSegmentIndex);
      this.notifyTick();
      await this.engine.stop();
      this.cancelTick();
      return;
    }

    const moment = resolveSessionMoment(this.session, elapsedSeconds);
    this.applySoundState(moment.soundState);
    this.playbackState = {
      ...moment.playbackState,
      status: 'playing',
    };
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    this.notifyTick();
    this.scheduleTick();
  };

  private notifyTick(): void {
    this.tickSubscribers.forEach((callback) => callback(this.playbackState));
  }

  private notifySegment(index: number): void {
    if (this.lastSegmentIndex === index) {
      return;
    }

    this.lastSegmentIndex = index;
    const segment = this.session.segments[index];
    if (!segment) {
      return;
    }

    this.segmentSubscribers.forEach((callback) => callback(index, segment));
  }

  private applySoundState(
    soundState:
      | SessionDefinition['segments'][number]['state']
      | undefined,
  ): void {
    if (!soundState) {
      return;
    }

    this.engine.setBaseParams({
      pairs: soundState.pairs,
      masterGain: soundState.masterGain,
    });
    this.engine.setNoise(soundState.noise);
  }
}
