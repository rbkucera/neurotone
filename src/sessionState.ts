import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import { type EngineSnapshot, type NoiseModel } from './audio/binauralEngine';
import type {
  AudioIntent,
  CompositionRequest,
  SegmentOverrideTarget,
  SessionDefinition,
} from './sequencer/types';
import {
  createSessionDefinition,
  createSessionSegment,
  sanitizeSessionSoundState,
} from './sequencer/utils';
import defaultSessionData from './catalog/sessions/soft-arrival.json';

export const SESSION_STORAGE_KEY = 'neurotone.session.v4';
export const HEADPHONE_NOTICE_KEY = 'neurotone.headphone-notice.v1';
const MASTER_VOLUME_KEY = 'neurotone.master-volume.v1';
const HIGH_VOLUME_WARNING_KEY = 'neurotone.high-volume-warning.v1';
const SAVED_SESSIONS_KEY = 'neurotone.saved-sessions.v1';

export type PlaybackMode = 'timeline' | 'visualizer';

export interface ComposerDraft {
  label: string;
  source: string;
  stepDuration: number;
  intent: AudioIntent;
}

export interface ShareableState {
  presetId: string | null;
  mode: PlaybackMode;
  session: SessionDefinition;
  composer: ComposerDraft;
}

interface CompactNoiseV5 {
  e?: 1;
  v?: number;
  m?: NoiseModel;
}

interface CompactPairV5 {
  i: string;
  c?: number;
  b?: number;
  g?: number;
}

interface CompactOverrideKeyframeV5 {
  t: number;
  v: number | boolean | NoiseModel;
}

interface CompactOverrideLaneV5 {
  t: SegmentOverrideTarget;
  p?: 's';
  e?: 0;
  k: CompactOverrideKeyframeV5[];
}

interface CompactSegmentStateV5 {
  p: CompactPairV5[];
  m?: number;
  n?: CompactNoiseV5;
}

interface CompactSegmentV5 {
  l?: string;
  h?: number;
  tr?: number;
  s: CompactSegmentStateV5;
  o?: CompactOverrideLaneV5[];
}

interface CompactSessionV5 {
  l?: string;
  lp?: 1;
  s: CompactSegmentV5[];
}

interface CompactShareStateV5 {
  m?: 't' | 'v';
  s: CompactSessionV5;
}

const DEFAULTS = {
  sessionLabel: 'New Session',
  segmentLabel: 'Segment',
  holdDuration: 12,
  transitionDuration: 4,
  carrierHz: 200,
  beatHz: 10,
  gain: 1,
  noiseEnabled: false,
  noiseVolume: 0.06,
  noiseModel: 'soft' as NoiseModel,
};

function createDefaultComposerDraft(): ComposerDraft {
  return {
    label: 'Composed Session',
    source: 'Am Fmaj7/2 C G',
    stepDuration: 16,
    intent: 'mixed',
  };
}

function createDefaultSession(): SessionDefinition {
  return createSessionDefinition(
    defaultSessionData as Partial<SessionDefinition>,
  );
}

export function normalizeShareableState(
  input: Partial<ShareableState> = {},
): ShareableState {
  const session =
    input.session !== undefined
      ? createSessionDefinition(input.session)
      : createDefaultSession();

  return {
    presetId: input.presetId ?? null,
    mode: input.mode === 'visualizer' ? 'visualizer' : 'timeline',
    session,
    composer: {
      ...createDefaultComposerDraft(),
      ...(input.composer ?? {}),
      label: input.composer?.label?.trim() || createDefaultComposerDraft().label,
      source: input.composer?.source ?? createDefaultComposerDraft().source,
      stepDuration: Math.max(1, input.composer?.stepDuration ?? createDefaultComposerDraft().stepDuration),
      intent: input.composer?.intent ?? createDefaultComposerDraft().intent,
    },
  };
}

export function stateFromSnapshot(
  snapshot: EngineSnapshot,
  presetId: string | null = null,
): ShareableState {
  return normalizeShareableState({
    presetId,
    session: createSessionDefinition({
      label: presetId ? `${presetId} session` : 'Manual session',
      loop: false,
      metadata: {
        source: 'manual',
      },
      segments: [
        createSessionSegment({
          label: 'Segment 1',
          holdDuration: 18,
          transitionDuration: 0,
          state: sanitizeSessionSoundState({
            pairs: snapshot.base.pairs,
            gain: snapshot.base.masterGain,
            noise: snapshot.noise,
          }),
        }),
      ],
    }),
  });
}

export function composerDraftToRequest(draft: ComposerDraft): CompositionRequest {
  return {
    label: draft.label,
    source: draft.source,
    stepDuration: draft.stepDuration,
    intent: draft.intent,
  };
}

function compactNoiseV5(
  enabled: boolean,
  volume: number,
  model: NoiseModel,
): CompactNoiseV5 | undefined {
  const compact: CompactNoiseV5 = {};
  if (enabled !== DEFAULTS.noiseEnabled) {
    compact.e = enabled ? 1 : undefined;
  }
  if (volume !== DEFAULTS.noiseVolume) {
    compact.v = volume;
  }
  if (model !== DEFAULTS.noiseModel) {
    compact.m = model;
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function compactShareStateV5(state: ShareableState): CompactShareStateV5 {
  const normalized = normalizeShareableState(state);

  return {
    m: normalized.mode === 'visualizer' ? 'v' : 't',
    s: {
      l:
        normalized.session.label &&
        normalized.session.label !== DEFAULTS.sessionLabel
          ? normalized.session.label
          : undefined,
      lp: normalized.session.loop ? 1 : undefined,
      s: normalized.session.segments.map((segment, index) => {
        const transitionDefault =
          index === 0 ? 0 : DEFAULTS.transitionDuration;
        const compactSegment: CompactSegmentV5 = {
          l:
            segment.label && segment.label !== DEFAULTS.segmentLabel
              ? segment.label
              : undefined,
          h:
            segment.holdDuration !== DEFAULTS.holdDuration
              ? segment.holdDuration
              : undefined,
          tr:
            segment.transitionDuration !== transitionDefault
              ? segment.transitionDuration
              : undefined,
          s: {
            p: segment.state.pairs.map((pair) => ({
              i: pair.id,
              c:
                pair.carrierHz !== DEFAULTS.carrierHz
                  ? pair.carrierHz
                  : undefined,
              b:
                pair.beatHz !== DEFAULTS.beatHz
                  ? pair.beatHz
                  : undefined,
              g: pair.gain !== DEFAULTS.gain ? pair.gain : undefined,
            })),
            m:
              segment.state.gain !== DEFAULTS.gain
                ? segment.state.gain
                : undefined,
            n: compactNoiseV5(
              segment.state.noise.enabled,
              segment.state.noise.volume,
              segment.state.noise.model,
            ),
          },
          o:
            segment.overrides.length > 0
              ? segment.overrides.map((lane) => ({
                  t: lane.target,
                  p: lane.interpolation === 'step' ? 's' : undefined,
                  e: lane.enabled ? undefined : 0,
                  k: lane.keyframes.map((keyframe) => ({
                    t: keyframe.time,
                    v: keyframe.value,
                  })),
                }))
              : undefined,
        };

        return compactSegment;
      }),
    },
  };
}

function expandNoiseV5(input: CompactNoiseV5 | undefined): {
  enabled: boolean;
  volume: number;
  model: NoiseModel;
} {
  return {
    enabled: input?.e === 1,
    volume: input?.v ?? DEFAULTS.noiseVolume,
    model: input?.m ?? DEFAULTS.noiseModel,
  };
}

function expandCompactShareStateV5(
  input: Partial<CompactShareStateV5>,
): Partial<ShareableState> {
  const segments =
    input.s?.s?.map((segment, segmentIndex) =>
      createSessionSegment({
        label: segment.l,
        holdDuration: segment.h ?? DEFAULTS.holdDuration,
        transitionDuration:
          segment.tr ??
          (segmentIndex === 0 ? 0 : DEFAULTS.transitionDuration),
        state: {
          pairs:
            segment.s?.p?.map((pair) => ({
              id: pair.i,
              carrierHz: pair.c ?? DEFAULTS.carrierHz,
              beatHz: pair.b ?? DEFAULTS.beatHz,
              gain: pair.g ?? DEFAULTS.gain,
            })) ?? [],
          gain: segment.s?.m ?? DEFAULTS.gain,
          noise: expandNoiseV5(segment.s?.n),
        },
        overrides:
          segment.o?.map((lane, laneIndex) => ({
            id: `override-${segmentIndex}-${laneIndex}`,
            label: lane.t,
            target: (lane.t as string) === 'masterGain' ? 'gain' : lane.t,
            interpolation: lane.p === 's' ? 'step' : 'linear',
            enabled: lane.e === 0 ? false : true,
            keyframes:
              lane.k?.map((keyframe, keyframeIndex) => ({
                id: `keyframe-${segmentIndex}-${laneIndex}-${keyframeIndex}`,
                time: keyframe.t,
                value: keyframe.v,
              })) ?? [],
          })) ?? [],
      }),
    ) ?? [];

  const expandedSession = createSessionDefinition({
    label: input.s?.l,
    loop: input.s?.lp === 1,
    segments,
    automationLanes: [],
  });

  return {
    mode: input.m === 'v' ? 'visualizer' : 'timeline',
    session: expandedSession,
  };
}

export function decodeInitialViewHintFromHash(
  hash: string,
): 'analysis' | null {
  const trimmedHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmedHash) {
    return null;
  }

  try {
    const params = new URLSearchParams(trimmedHash);
    const version = params.get('v');
    const compressed = params.get('z');
    if (version !== '5' || !compressed) {
      return null;
    }

    const decompressed = decompressFromEncodedURIComponent(compressed);
    if (!decompressed) {
      return null;
    }

    const parsed = JSON.parse(decompressed) as Partial<CompactShareStateV5>;
    return parsed.m === undefined ? 'analysis' : null;
  } catch {
    return null;
  }
}

export function encodeShareableState(state: ShareableState): string {
  const compact = compactShareStateV5(state);
  const compressedPayload = compressToEncodedURIComponent(
    JSON.stringify(compact),
  );
  const params = new URLSearchParams();
  params.set('v', '5');
  params.set('z', compressedPayload);
  return params.toString();
}

export function decodeShareableState(hash: string): ShareableState | null {
  const trimmedHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmedHash) {
    return null;
  }

  try {
    const params = new URLSearchParams(trimmedHash);
    const version = params.get('v');
    const compressed = params.get('z');
    if (version !== '5' || !compressed) {
      return null;
    }

    const decompressed = decompressFromEncodedURIComponent(compressed);
    if (!decompressed) {
      return null;
    }

    return normalizeShareableState(
      expandCompactShareStateV5(
        JSON.parse(decompressed) as Partial<CompactShareStateV5>,
      ),
    );
  } catch {
    return null;
  }
}

export function loadStoredState(): ShareableState | null {
  try {
    const rawState = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!rawState) {
      return null;
    }

    return normalizeShareableState(
      JSON.parse(rawState) as Partial<ShareableState>,
    );
  } catch {
    return null;
  }
}

export function loadStoredStateViewHint(): 'analysis' | null {
  try {
    const rawState = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!rawState) {
      return null;
    }

    const parsed = JSON.parse(rawState) as Partial<{ mode?: string }>;
    return parsed.mode === 'manual' ? 'analysis' : null;
  } catch {
    return null;
  }
}

export function saveStoredState(state: ShareableState): void {
  try {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(normalizeShareableState(state)),
    );
  } catch {
    // Fails silently for blocked storage or quota issues.
  }
}

export function hasSeenHeadphoneNotice(): boolean {
  try {
    return window.localStorage.getItem(HEADPHONE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHeadphoneNoticeSeen(): void {
  try {
    window.localStorage.setItem(HEADPHONE_NOTICE_KEY, '1');
  } catch {
    // Fails silently for blocked storage or quota issues.
  }
}

export function hasSeenHighVolumeWarning(): boolean {
  try {
    return window.localStorage.getItem(HIGH_VOLUME_WARNING_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHighVolumeWarningSeen(): void {
  try {
    window.localStorage.setItem(HIGH_VOLUME_WARNING_KEY, '1');
  } catch {
    // Fails silently for blocked storage or quota issues.
  }
}

export function loadMasterVolume(): number {
  try {
    const raw = window.localStorage.getItem(MASTER_VOLUME_KEY);
    if (raw !== null) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        return Math.min(1, Math.max(0, value));
      }
    }
  } catch {
    // Fails silently for blocked storage or quota issues.
  }
  return 0.22;
}

export function saveMasterVolume(value: number): void {
  try {
    window.localStorage.setItem(MASTER_VOLUME_KEY, String(value));
  } catch {
    // Fails silently for blocked storage or quota issues.
  }
}

export function createInitialShareableState(): ShareableState {
  const session = createDefaultSession();

  return normalizeShareableState({
    mode: 'visualizer',
    session,
  });
}

// ---------------------------------------------------------------------------
// Saved sessions (localStorage)
// ---------------------------------------------------------------------------

export interface SavedSession {
  id: string;
  label: string;
  savedAt: string;
  session: SessionDefinition;
}

export function loadSavedSessions(): SavedSession[] {
  try {
    const raw = window.localStorage.getItem(SAVED_SESSIONS_KEY);
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as SavedSession[];
  } catch {
    return [];
  }
}

function persistSavedSessions(sessions: SavedSession[]): void {
  window.localStorage.setItem(SAVED_SESSIONS_KEY, JSON.stringify(sessions));
}

export function saveSessionToLibrary(session: SessionDefinition): SavedSession {
  const sessions = loadSavedSessions();
  const saved: SavedSession = {
    id: `saved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: session.label || 'Untitled session',
    savedAt: new Date().toISOString(),
    session: createSessionDefinition(session),
  };
  sessions.unshift(saved);
  persistSavedSessions(sessions);
  return saved;
}

export function updateSavedSession(
  id: string,
  session: SessionDefinition,
): void {
  const sessions = loadSavedSessions();
  const index = sessions.findIndex((s) => s.id === id);
  if (index !== -1) {
    sessions[index] = {
      ...sessions[index],
      label: session.label || sessions[index].label,
      savedAt: new Date().toISOString(),
      session: createSessionDefinition(session),
    };
    persistSavedSessions(sessions);
  }
}

export function deleteSavedSession(id: string): void {
  const sessions = loadSavedSessions().filter((s) => s.id !== id);
  persistSavedSessions(sessions);
}

export function exportSavedSessions(): string {
  return JSON.stringify(loadSavedSessions(), null, 2);
}

export function importSavedSessions(json: string): number {
  const incoming = JSON.parse(json) as SavedSession[];
  if (!Array.isArray(incoming)) {
    return 0;
  }
  const existing = loadSavedSessions();
  const existingIds = new Set(existing.map((s) => s.id));
  const newSessions = incoming.filter((s) => s.id && !existingIds.has(s.id));
  if (newSessions.length === 0) {
    return 0;
  }
  persistSavedSessions([...newSessions, ...existing]);
  return newSessions.length;
}
