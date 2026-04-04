import {
  sanitizeNoiseConfig,
  sanitizeTonePair,
  type NoiseConfig,
  type TonePair,
} from '../audio/binauralEngine';
import {
  type AutomationLane,
  type AutomationTarget,
  type SegmentOverrideLane,
  type SegmentOverrideTarget,
  type SessionDefinition,
  type SessionPlaybackState,
  type SessionSegment,
  type SessionSoundState,
} from './types';

function createId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function createLaneId(target: AutomationTarget): string {
  return target
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sanitizeSessionSoundState(
  input: Partial<SessionSoundState>,
): SessionSoundState {
  return {
    pairs:
      input.pairs?.map((pair) => sanitizeTonePair(pair)) ?? [sanitizeTonePair()],
    masterGain: clamp(input.masterGain ?? 0.22, 0, 1),
    noise: sanitizeNoiseConfig(input.noise ?? {}),
  };
}

function normalizeOverrideValue(
  target: SegmentOverrideTarget,
  value: number | boolean | NoiseConfig['model'],
): number | boolean | NoiseConfig['model'] {
  if (target === 'noise.enabled') {
    return Boolean(value);
  }

  if (target === 'noise.model') {
    return typeof value === 'string' ? value : 'soft';
  }

  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }

  if (target === 'masterGain' || target === 'noise.volume' || target.endsWith('.gain')) {
    return clamp(value, 0, 1);
  }

  if (target.endsWith('.beatHz')) {
    return Math.max(0, value);
  }

  if (target.endsWith('.carrierHz')) {
    return Math.max(1, value);
  }

  return value;
}

function sanitizeSegmentOverrideLane(
  input: Partial<SegmentOverrideLane>,
): SegmentOverrideLane {
  const target = (input.target ?? 'masterGain') as SegmentOverrideTarget;
  const keyframes =
    input.keyframes?.map((keyframe) => ({
      id: keyframe.id ?? createId('keyframe'),
      time: Math.max(0, keyframe.time ?? 0),
      value: normalizeOverrideValue(target, keyframe.value ?? 0),
    })) ?? [];

  return {
    id: input.id ?? createId('override'),
    label: input.label ?? target,
    target,
    interpolation: input.interpolation === 'step' ? 'step' : 'linear',
    enabled: input.enabled ?? true,
    keyframes: keyframes.sort((left, right) => left.time - right.time),
  };
}

export function createSessionSegment(
  input: Partial<SessionSegment> = {},
): SessionSegment {
  return {
    id: input.id ?? createId('segment'),
    label: input.label ?? 'Segment',
    state: sanitizeSessionSoundState(input.state ?? {}),
    holdDuration: Math.max(1, input.holdDuration ?? 12),
    transitionDuration: Math.max(0, input.transitionDuration ?? 4),
    overrides: input.overrides?.map((lane) => sanitizeSegmentOverrideLane(lane)) ?? [],
  };
}

export function createSessionDefinition(
  input: Partial<SessionDefinition> = {},
): SessionDefinition {
  const segments =
    input.segments?.map((segment) => createSessionSegment(segment)) ??
    [createSessionSegment()];

  return {
    id: input.id ?? createId('session'),
    label: input.label ?? 'Untitled session',
    loop: input.loop ?? false,
    segments,
    // Legacy global lanes are ignored in v4 in favor of segment-owned overrides.
    automationLanes: [],
    metadata: input.metadata,
  };
}

export function totalSessionDuration(session: SessionDefinition): number {
  return session.segments.reduce((total, segment, index) => {
    return (
      total +
      segment.holdDuration +
      (index === 0 ? 0 : segment.transitionDuration)
    );
  }, 0);
}

export interface SegmentWindow {
  index: number;
  segment: SessionSegment;
  transitionStart: number;
  holdStart: number;
  end: number;
}

export function buildSegmentWindows(session: SessionDefinition): SegmentWindow[] {
  let cursor = 0;

  return session.segments.map((segment, index) => {
    const transitionDuration = index === 0 ? 0 : segment.transitionDuration;
    const transitionStart = cursor;
    const holdStart = transitionStart + transitionDuration;
    const end = holdStart + segment.holdDuration;
    cursor = end;

    return {
      index,
      segment,
      transitionStart,
      holdStart,
      end,
    };
  });
}

function segmentWindowDuration(window: SegmentWindow): number {
  return Math.max(window.end - window.transitionStart, 0.0001);
}

function pairMap(pairs: TonePair[]): Map<string, TonePair> {
  return new Map(pairs.map((pair) => [pair.id, sanitizeTonePair(pair)]));
}

function interpolateNumber(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

export function interpolateSoundStates(
  from: SessionSoundState,
  to: SessionSoundState,
  progress: number,
): SessionSoundState {
  const clampedProgress = clamp(progress, 0, 1);
  const fromPairs = pairMap(from.pairs);
  const toPairs = pairMap(to.pairs);
  const ids = new Set([...fromPairs.keys(), ...toPairs.keys()]);

  const pairs = Array.from(ids).map((id) => {
    const fromPair = fromPairs.get(id);
    const toPair = toPairs.get(id);

    if (fromPair && toPair) {
      return sanitizeTonePair({
        id,
        carrierHz: interpolateNumber(
          fromPair.carrierHz,
          toPair.carrierHz,
          clampedProgress,
        ),
        beatHz: interpolateNumber(
          fromPair.beatHz,
          toPair.beatHz,
          clampedProgress,
        ),
        gain: interpolateNumber(fromPair.gain, toPair.gain, clampedProgress),
      });
    }

    if (toPair) {
      return sanitizeTonePair({
        ...toPair,
        gain: interpolateNumber(0, toPair.gain, clampedProgress),
      });
    }

    return sanitizeTonePair({
      ...fromPair!,
      gain: interpolateNumber(fromPair!.gain, 0, clampedProgress),
    });
  });

  return sanitizeSessionSoundState({
    pairs,
    masterGain: interpolateNumber(
      from.masterGain,
      to.masterGain,
      clampedProgress,
    ),
    noise: {
      enabled:
        clampedProgress < 0.5 ? from.noise.enabled : to.noise.enabled,
      model: clampedProgress < 0.5 ? from.noise.model : to.noise.model,
      volume: interpolateNumber(
        from.noise.volume,
        to.noise.volume,
        clampedProgress,
      ),
    },
  });
}

function applyLaneValue(
  state: SessionSoundState,
  target: SegmentOverrideTarget,
  value: number | boolean | NoiseConfig['model'],
): void {
  if (target === 'masterGain' && typeof value === 'number') {
    state.masterGain = clamp(value, 0, 1);
    return;
  }

  if (target === 'noise.volume' && typeof value === 'number') {
    state.noise.volume = clamp(value, 0, 1);
    return;
  }

  if (target === 'noise.enabled' && typeof value === 'boolean') {
    state.noise.enabled = value;
    return;
  }

  if (target === 'noise.model' && typeof value === 'string') {
    state.noise.model = value;
    return;
  }

  const pairMatch = target.match(/^pair:(.+)\.(carrierHz|beatHz|gain)$/);
  if (!pairMatch) {
    return;
  }

  const [, pairId, field] = pairMatch;
  if (typeof value !== 'number') {
    return;
  }

  const pair = state.pairs.find((item) => item.id === pairId);
  if (!pair) {
    return;
  }

  if (field === 'carrierHz') {
    pair.carrierHz = value;
    return;
  }

  if (field === 'beatHz') {
    pair.beatHz = value;
    return;
  }

  pair.gain = value;
}

function sampleLaneValue(
  lane: SegmentOverrideLane,
  time: number,
): number | boolean | NoiseConfig['model'] | null {
  const keyframes = [...lane.keyframes].sort((left, right) => left.time - right.time);
  if (keyframes.length === 0) {
    return null;
  }

  if (time <= keyframes[0].time) {
    return keyframes[0].value;
  }

  const lastKeyframe = keyframes[keyframes.length - 1];
  if (time >= lastKeyframe.time) {
    return lastKeyframe.value;
  }

  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const current = keyframes[index];
    const next = keyframes[index + 1];

    if (time < current.time || time > next.time) {
      continue;
    }

    if (
      lane.interpolation === 'step' ||
      typeof current.value !== 'number' ||
      typeof next.value !== 'number'
    ) {
      return current.value;
    }

    const progress = (time - current.time) / Math.max(next.time - current.time, 0.0001);
    return interpolateNumber(current.value, next.value, progress);
  }

  return lastKeyframe.value;
}

export function applySegmentOverrides(
  baseState: SessionSoundState,
  lanes: SegmentOverrideLane[],
  localTime: number,
): SessionSoundState {
  const nextState = sanitizeSessionSoundState(baseState);

  lanes
    .filter((lane) => lane.enabled)
    .forEach((lane) => {
      const sampledValue = sampleLaneValue(lane, localTime);
      if (sampledValue === null) {
        return;
      }

      applyLaneValue(nextState, lane.target, sampledValue);
    });

  return sanitizeSessionSoundState(nextState);
}

// Legacy helper retained for compatibility with existing imports/tests.
export function applyAutomationLanes(
  baseState: SessionSoundState,
  lanes: AutomationLane[],
  time: number,
): SessionSoundState {
  return applySegmentOverrides(baseState, lanes as SegmentOverrideLane[], time);
}

export function buildAutomationLanesFromSegments(
  session: SessionDefinition,
): AutomationLane[] {
  const windows = buildSegmentWindows(session);
  const keyframesByTarget = new Map<
    AutomationTarget,
    AutomationLane['keyframes']
  >();

  const pushKeyframe = (
    target: AutomationTarget,
    time: number,
    value: number | boolean | NoiseConfig['model'],
  ): void => {
    const existing = keyframesByTarget.get(target) ?? [];
    existing.push({
      id: createId('keyframe'),
      time,
      value,
    });
    keyframesByTarget.set(target, existing);
  };

  windows.forEach((window, index) => {
    const segmentState = window.segment.state;
    const time = index === 0 ? 0 : window.holdStart;

    pushKeyframe('masterGain', time, segmentState.masterGain);
    pushKeyframe('noise.volume', time, segmentState.noise.volume);
    pushKeyframe('noise.enabled', time, segmentState.noise.enabled);
    pushKeyframe('noise.model', time, segmentState.noise.model);

    segmentState.pairs.forEach((pair) => {
      pushKeyframe(`pair:${pair.id}.carrierHz`, time, pair.carrierHz);
      pushKeyframe(`pair:${pair.id}.beatHz`, time, pair.beatHz);
      pushKeyframe(`pair:${pair.id}.gain`, time, pair.gain);
    });
  });

  return Array.from(keyframesByTarget.entries()).map(([target, keyframes]) => ({
    id: `lane-${createLaneId(target)}`,
    label: target,
    target,
    interpolation:
      target === 'noise.enabled' || target === 'noise.model' ? 'step' : 'linear',
    enabled: true,
    source: 'segment',
    keyframes: keyframes.sort((left, right) => left.time - right.time),
  }));
}

export function rebuildSessionAutomationLanes(
  session: SessionDefinition,
): SessionDefinition {
  return createSessionDefinition(session);
}

export interface ResolvedSessionMoment {
  soundState: SessionSoundState;
  playbackState: SessionPlaybackState;
}

export function resolveSegmentLoopMoment(
  session: SessionDefinition,
  segmentId: string,
  time: number,
): ResolvedSessionMoment {
  const segmentIndex = session.segments.findIndex(
    (segment) => segment.id === segmentId,
  );
  if (segmentIndex < 0) {
    return resolveSessionMoment(session, time);
  }

  const segment = session.segments[segmentIndex]!;
  const loopDuration = Math.max(
    0.0001,
    segment.holdDuration + segment.transitionDuration,
  );
  const boundedTime = ((time % loopDuration) + loopDuration) % loopDuration;

  return {
    soundState: applySegmentOverrides(
      segment.state,
      segment.overrides,
      boundedTime,
    ),
    playbackState: {
      status: 'playing',
      currentSegmentIndex: segmentIndex,
      currentSegmentPhase: 'holding',
      elapsedInPhase: boundedTime,
      totalElapsed: boundedTime,
      totalDuration: loopDuration,
    },
  };
}

export function resolveSessionMoment(
  session: SessionDefinition,
  time: number,
): ResolvedSessionMoment {
  const totalDuration = totalSessionDuration(session);
  const windows = buildSegmentWindows(session);

  if (windows.length === 0) {
    return {
      soundState: sanitizeSessionSoundState({}),
      playbackState: {
        status: 'idle',
        currentSegmentIndex: 0,
        currentSegmentPhase: 'holding',
        elapsedInPhase: 0,
        totalElapsed: 0,
        totalDuration: 0,
      },
    };
  }

  const boundedTime =
    session.loop && totalDuration > 0
      ? ((time % totalDuration) + totalDuration) % totalDuration
      : clamp(time, 0, totalDuration);

  const firstWindow = windows[0];
  const lastWindow = windows[windows.length - 1];
  if (
    session.loop &&
    totalDuration > 0 &&
    windows.length > 1 &&
    firstWindow &&
    lastWindow &&
    firstWindow.segment.transitionDuration > 0
  ) {
    const wrapTransitionDuration = firstWindow.segment.transitionDuration;
    const wrapTransitionStart = totalDuration - wrapTransitionDuration;
    if (boundedTime >= wrapTransitionStart) {
      const localTransitionTime = boundedTime - wrapTransitionStart;
      const progress =
        localTransitionTime / Math.max(wrapTransitionDuration, 0.0001);
      const baseState = interpolateSoundStates(
        lastWindow.segment.state,
        firstWindow.segment.state,
        progress,
      );

      return {
        soundState: applySegmentOverrides(
          baseState,
          firstWindow.segment.overrides,
          localTransitionTime,
        ),
        playbackState: {
          status: 'playing',
          currentSegmentIndex: 0,
          currentSegmentPhase: 'transitioning',
          elapsedInPhase: localTransitionTime,
          totalElapsed: boundedTime,
          totalDuration,
        },
      };
    }
  }

  for (const window of windows) {
    const isLast = window.index === windows.length - 1;
    if (boundedTime >= window.end && !isLast) {
      continue;
    }

    if (
      window.index > 0 &&
      boundedTime >= window.transitionStart &&
      boundedTime < window.holdStart
    ) {
      const previousSegment = windows[window.index - 1].segment;
      const progress =
        (boundedTime - window.transitionStart) /
        Math.max(window.segment.transitionDuration, 0.0001);
      const baseState = interpolateSoundStates(
        previousSegment.state,
        window.segment.state,
        progress,
      );

      return {
        soundState: applySegmentOverrides(
          baseState,
          window.segment.overrides,
          boundedTime - window.transitionStart,
        ),
        playbackState: {
          status: 'playing',
          currentSegmentIndex: window.index,
          currentSegmentPhase: 'transitioning',
          elapsedInPhase: boundedTime - window.transitionStart,
          totalElapsed: boundedTime,
          totalDuration,
        },
      };
    }

    if (boundedTime < window.end || isLast) {
      return {
        soundState: applySegmentOverrides(
          window.segment.state,
          window.segment.overrides,
          boundedTime - window.transitionStart,
        ),
        playbackState: {
          status: 'playing',
          currentSegmentIndex: window.index,
          currentSegmentPhase: 'holding',
          elapsedInPhase: Math.max(0, boundedTime - window.holdStart),
          totalElapsed: boundedTime,
          totalDuration,
        },
      };
    }
  }

  const lastSegment = windows[windows.length - 1].segment;
  const fallbackLastWindow = windows[windows.length - 1];
  return {
    soundState: applySegmentOverrides(
      lastSegment.state,
      lastSegment.overrides,
      segmentWindowDuration(fallbackLastWindow),
    ),
    playbackState: {
      status: 'complete',
      currentSegmentIndex: windows.length - 1,
      currentSegmentPhase: 'holding',
      elapsedInPhase: lastSegment.holdDuration,
      totalElapsed: totalDuration,
      totalDuration,
    },
  };
}
