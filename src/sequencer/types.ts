import type {
  NoiseConfig,
  NoiseModel,
  TonePair,
} from '../audio/binauralEngine';

export type AudioIntent = 'delta' | 'theta' | 'alpha' | 'beta' | 'mixed';

export interface SessionSoundState {
  pairs: TonePair[];
  masterGain: number;
  noise: NoiseConfig;
}

export type SegmentOverrideTarget =
  | 'masterGain'
  | 'noise.volume'
  | 'noise.enabled'
  | 'noise.model'
  | `pair:${string}.carrierHz`
  | `pair:${string}.beatHz`
  | `pair:${string}.gain`;

export interface SegmentOverrideKeyframe {
  id: string;
  time: number;
  value: number | boolean | NoiseModel;
}

export interface SegmentOverrideLane {
  id: string;
  label: string;
  target: SegmentOverrideTarget;
  interpolation: 'linear' | 'step';
  enabled: boolean;
  keyframes: SegmentOverrideKeyframe[];
}

export interface SessionSegment {
  id: string;
  label?: string;
  state: SessionSoundState;
  holdDuration: number;
  transitionDuration: number;
  overrides: SegmentOverrideLane[];
}

// Legacy global automation model retained only for decode compatibility.
export type AutomationTarget = SegmentOverrideTarget;

export interface AutomationKeyframe {
  id: string;
  time: number;
  value: number | boolean | NoiseModel;
}

export interface AutomationLane {
  id: string;
  label: string;
  target: AutomationTarget;
  interpolation: 'linear' | 'step';
  enabled: boolean;
  source?: 'segment' | 'custom';
  keyframes: AutomationKeyframe[];
}

export interface SessionDefinition {
  id: string;
  label: string;
  loop: boolean;
  segments: SessionSegment[];
  automationLanes: AutomationLane[];
  metadata?: {
    source?: 'manual' | 'generated';
    intent?: AudioIntent;
    input?: string;
  };
}

export interface SessionPlaybackState {
  status: 'idle' | 'playing' | 'paused' | 'complete';
  currentSegmentIndex: number;
  currentSegmentPhase: 'transitioning' | 'holding';
  elapsedInPhase: number;
  totalElapsed: number;
  totalDuration: number;
}

export interface CompositionRequest {
  label: string;
  source: string;
  stepDuration: number;
  intent: AudioIntent;
}

export interface GeneratedPlan {
  session: SessionDefinition;
  explanation: string[];
}
