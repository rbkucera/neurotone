import type { BinauralEngine } from '../audio/binauralEngine';
import {
  type SessionDefinition,
  type SessionPlaybackState,
  type SessionSegment,
} from './types';
import {
  createSessionDefinition,
  createSessionSegment,
  type ResolvedSessionMoment,
  resolveSegmentLoopMoment,
  resolveSessionMoment,
  rebuildSessionAutomationLanes,
  totalSessionDuration,
} from './utils';

const HIDDEN_TAB_TICK_INTERVAL_MS = 140;

type PlaybackTarget =
  | 'session'
  | {
      type: 'segment-loop';
      segmentId: string;
    };

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

  private timeoutId: number | null = null;

  private tickSubscribers = new Set<(state: SessionPlaybackState) => void>();

  private segmentSubscribers = new Set<
    (index: number, segment: SessionSegment) => void
  >();

  private startedAtMs = 0;

  private pausedAtSeconds = 0;

  private lastSegmentIndex = -1;

  private visibilitySyncActive = false;

  private playbackTarget: PlaybackTarget = 'session';

  private masterVolume = 0.22;

  private loopOverride: boolean | null = null;

  constructor(private readonly engine: BinauralEngine) {}

  load(session: SessionDefinition): void {
    this.cancelTick();
    this.detachVisibilitySync();
    this.session = rebuildSessionAutomationLanes(createSessionDefinition(session));
    this.playbackTarget = 'session';
    this.loopOverride = null;
    this.pausedAtSeconds = 0;
    this.lastSegmentIndex = -1;
    const initialMoment = this.resolveMoment(0);
    this.playbackState = {
      ...initialMoment.playbackState,
      status: 'idle',
      elapsedInPhase: 0,
      totalElapsed: 0,
    };
    this.applySoundState(initialMoment.soundState);
    this.notifyTick();
  }

  setMasterVolume(value: number): void {
    this.masterVolume = Math.min(1, Math.max(0, value));
    if (this.playbackState.status === 'playing' || this.playbackState.status === 'paused') {
      const moment = this.resolveMoment(this.playbackState.totalElapsed);
      this.applySoundState(moment.soundState);
    }
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
    this.playbackTarget = this.normalizePlaybackTarget(this.playbackTarget);
    this.playbackState.totalDuration = this.totalDurationForTarget();

    if (this.playbackState.status === 'idle') {
      const idleMoment = this.resolveMoment(0);
      this.playbackState = {
        ...idleMoment.playbackState,
        status: 'idle',
        totalElapsed: 0,
        elapsedInPhase: 0,
      };
      this.applySoundState(idleMoment.soundState);
      this.notifySegment(idleMoment.playbackState.currentSegmentIndex);
      this.notifyTick();
      return;
    }

    const effectiveElapsed = this.normalizeElapsedForTarget(preservedElapsed);

    this.pausedAtSeconds = effectiveElapsed;
    if (this.playbackState.status === 'playing') {
      this.startedAtMs = performance.now() - effectiveElapsed * 1000;
    }

    const moment = this.resolveMoment(effectiveElapsed);
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

  setPlaybackTarget(target: PlaybackTarget): void {
    const normalizedTarget = this.normalizePlaybackTarget(target);
    if (this.isSamePlaybackTarget(this.playbackTarget, normalizedTarget)) {
      return;
    }

    this.playbackTarget = normalizedTarget;
    const preservedElapsed =
      this.playbackState.status === 'playing' || this.playbackState.status === 'paused'
        ? this.playbackState.totalElapsed
        : 0;
    const effectiveElapsed = this.normalizeElapsedForTarget(preservedElapsed);
    this.pausedAtSeconds = effectiveElapsed;

    if (this.playbackState.status === 'playing') {
      this.startedAtMs = performance.now() - effectiveElapsed * 1000;
    }

    const nextStatus =
      this.playbackState.status === 'complete'
        ? 'idle'
        : this.playbackState.status;
    const moment = this.resolveMoment(effectiveElapsed);
    this.applySoundState(moment.soundState);
    this.playbackState = {
      ...moment.playbackState,
      status: nextStatus,
    };
    this.lastSegmentIndex = -1;
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    this.notifyTick();
  }

  setLoopOverride(loopOverride: boolean | null): void {
    const normalizedOverride =
      typeof loopOverride === 'boolean' ? loopOverride : null;
    if (this.loopOverride === normalizedOverride) {
      return;
    }

    this.loopOverride = normalizedOverride;
    if (this.playbackTarget !== 'session') {
      return;
    }

    const preservedElapsed =
      this.playbackState.status === 'playing' || this.playbackState.status === 'paused'
        ? this.playbackState.totalElapsed
        : 0;
    const effectiveElapsed = this.normalizeElapsedForTarget(preservedElapsed);
    this.pausedAtSeconds = effectiveElapsed;

    if (this.playbackState.status === 'playing') {
      this.startedAtMs = performance.now() - effectiveElapsed * 1000;
    }

    const nextStatus =
      this.playbackState.status === 'complete'
        ? 'idle'
        : this.playbackState.status;
    const moment = this.resolveMoment(effectiveElapsed);
    this.applySoundState(moment.soundState);
    this.playbackState = {
      ...moment.playbackState,
      status: nextStatus,
    };
    this.lastSegmentIndex = -1;
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    this.notifyTick();
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

    const effectiveElapsed = this.normalizeElapsedForTarget(startFromSeconds);
    this.pausedAtSeconds = effectiveElapsed;
    this.startedAtMs = performance.now() - effectiveElapsed * 1000;
    const moment = this.resolveMoment(effectiveElapsed);
    this.applySoundState(moment.soundState);
    this.playbackState = {
      ...moment.playbackState,
      status: 'playing',
    };
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    await this.engine.start();
    this.notifyTick();
    this.attachVisibilitySync();
    this.scheduleTick();
  }

  async pause(): Promise<void> {
    if (this.playbackState.status !== 'playing') {
      return;
    }

    this.pausedAtSeconds = this.playbackState.totalElapsed;
    this.playbackState.status = 'paused';
    this.cancelTick();
    this.detachVisibilitySync();
    await this.engine.stop();
    this.notifyTick();
  }

  async resume(): Promise<void> {
    if (this.playbackState.status !== 'paused') {
      return;
    }

    this.startedAtMs = performance.now() - this.pausedAtSeconds * 1000;
    const moment = this.resolveMoment(this.pausedAtSeconds);
    this.applySoundState(moment.soundState);
    await this.engine.start();
    this.playbackState = {
      ...moment.playbackState,
      status: 'playing',
    };
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    this.notifyTick();
    this.attachVisibilitySync();
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    this.cancelTick();
    this.detachVisibilitySync();
    this.pausedAtSeconds = 0;
    this.lastSegmentIndex = -1;
    const stoppedMoment = this.resolveMoment(0);
    this.playbackState = {
      ...stoppedMoment.playbackState,
      status: 'idle',
      elapsedInPhase: 0,
      totalElapsed: 0,
    };
    await this.engine.stop();
    this.applySoundState(stoppedMoment.soundState);
    this.notifySegment(stoppedMoment.playbackState.currentSegmentIndex);
    this.notifyTick();
  }

  seekToSegment(index: number): void {
    if (this.playbackTarget !== 'session') {
      this.seekToTime(0);
      return;
    }

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

    this.seekToTime(time);
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
    this.playbackTarget = this.normalizePlaybackTarget(this.playbackTarget);
    this.playbackState.totalDuration = this.totalDurationForTarget();
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
    this.playbackTarget = this.normalizePlaybackTarget(this.playbackTarget);
    this.playbackState.totalDuration = this.totalDurationForTarget();
    this.notifyTick();
  }

  updateSegment(id: string, patch: Partial<SessionSegment>): void {
    this.session = createSessionDefinition({
      ...this.session,
      segments: this.session.segments.map((segment) =>
        segment.id === id ? createSessionSegment({ ...segment, ...patch }) : segment,
      ),
    });
    this.playbackTarget = this.normalizePlaybackTarget(this.playbackTarget);
    this.playbackState.totalDuration = this.totalDurationForTarget();
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
    this.playbackTarget = this.normalizePlaybackTarget(this.playbackTarget);
    this.playbackState.totalDuration = this.totalDurationForTarget();
    this.notifyTick();
  }

  private scheduleTick(): void {
    this.cancelTick();
    if (this.shouldUseTimeoutScheduler()) {
      this.timeoutId = window.setTimeout(
        this.handleTimeoutTick,
        HIDDEN_TAB_TICK_INTERVAL_MS,
      );
      return;
    }

    this.animationFrameId = window.requestAnimationFrame(this.handleAnimationFrameTick);
  }

  private cancelTick(): void {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private shouldUseTimeoutScheduler(): boolean {
    return (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    );
  }

  private attachVisibilitySync(): void {
    if (this.visibilitySyncActive || typeof document === 'undefined') {
      return;
    }

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.visibilitySyncActive = true;
  }

  private detachVisibilitySync(): void {
    if (!this.visibilitySyncActive || typeof document === 'undefined') {
      return;
    }

    document.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    );
    this.visibilitySyncActive = false;
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.playbackState.status !== 'playing') {
      return;
    }

    this.scheduleTick();
  };

  private readonly handleAnimationFrameTick = (timestampMs: number): void => {
    this.animationFrameId = null;
    if (this.playbackState.status !== 'playing') {
      return;
    }

    void this.advancePlayback(timestampMs);
  };

  private readonly handleTimeoutTick = (): void => {
    this.timeoutId = null;
    if (this.playbackState.status !== 'playing') {
      return;
    }

    void this.advancePlayback(performance.now());
  };

  private async advancePlayback(timestampMs: number): Promise<void> {
    const elapsedSeconds = Math.max(0, (timestampMs - this.startedAtMs) / 1000);
    const totalDuration = this.totalDurationForTarget();

    if (
      this.playbackTarget === 'session' &&
      !this.isLoopEnabled() &&
      elapsedSeconds >= totalDuration
    ) {
      const finalMoment = this.resolveMoment(totalDuration);
      this.applySoundState(finalMoment.soundState);
      this.playbackState = {
        ...finalMoment.playbackState,
        status: 'complete',
      };
      this.notifySegment(finalMoment.playbackState.currentSegmentIndex);
      this.notifyTick();
      await this.engine.stop();
      this.cancelTick();
      this.detachVisibilitySync();
      return;
    }

    const moment = this.resolveMoment(elapsedSeconds);
    this.applySoundState(moment.soundState);
    this.playbackState = {
      ...moment.playbackState,
      status: 'playing',
    };
    this.notifySegment(moment.playbackState.currentSegmentIndex);
    this.notifyTick();
    this.scheduleTick();
  }

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
      masterGain: soundState.gain * this.masterVolume,
    });
    this.engine.setNoise(soundState.noise);
  }

  private seekToTime(time: number): void {
    const effectiveElapsed = this.normalizeElapsedForTarget(time);
    this.pausedAtSeconds = effectiveElapsed;
    this.startedAtMs = performance.now() - effectiveElapsed * 1000;
    const moment = this.resolveMoment(effectiveElapsed);
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

  private resolveMoment(time: number): ResolvedSessionMoment {
    if (this.playbackTarget === 'session') {
      if (this.loopOverride === null || this.loopOverride === this.session.loop) {
        return resolveSessionMoment(this.session, time);
      }

      return resolveSessionMoment(
        {
          ...this.session,
          loop: this.loopOverride,
        },
        time,
      );
    }

    return resolveSegmentLoopMoment(
      this.session,
      this.playbackTarget.segmentId,
      time,
    );
  }

  private totalDurationForTarget(): number {
    const playbackTarget = this.playbackTarget;
    if (playbackTarget === 'session') {
      return totalSessionDuration(this.session);
    }

    const segment = this.session.segments.find(
      (item) => item.id === playbackTarget.segmentId,
    );
    if (!segment) {
      return totalSessionDuration(this.session);
    }

    return Math.max(0.0001, segment.holdDuration + segment.transitionDuration);
  }

  private normalizeElapsedForTarget(elapsedSeconds: number): number {
    const totalDuration = this.totalDurationForTarget();
    if (totalDuration <= 0) {
      return 0;
    }

    if (this.playbackTarget !== 'session') {
      return ((elapsedSeconds % totalDuration) + totalDuration) % totalDuration;
    }

    return this.isLoopEnabled()
      ? ((elapsedSeconds % totalDuration) + totalDuration) % totalDuration
      : Math.min(Math.max(0, elapsedSeconds), totalDuration);
  }

  private isLoopEnabled(): boolean {
    return this.loopOverride ?? this.session.loop;
  }

  private normalizePlaybackTarget(target: PlaybackTarget): PlaybackTarget {
    if (target === 'session') {
      return 'session';
    }

    return this.session.segments.some(
      (segment) => segment.id === target.segmentId,
    )
      ? target
      : 'session';
  }

  private isSamePlaybackTarget(
    left: PlaybackTarget,
    right: PlaybackTarget,
  ): boolean {
    if (left === 'session' && right === 'session') {
      return true;
    }

    return (
      left !== 'session' &&
      right !== 'session' &&
      left.segmentId === right.segmentId
    );
  }
}
