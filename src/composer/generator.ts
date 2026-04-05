import { sanitizeTonePair } from '../audio/binauralEngine';
import type { TonePair, NoiseConfig } from '../audio/binauralEngine';
import type { CompositionRequest, GeneratedPlan, SessionSoundState } from '../sequencer/types';
import {
  createSessionDefinition,
  createSessionSegment,
  sanitizeSessionSoundState,
} from '../sequencer/utils';
import { parseCompositionSource } from './parser';

interface IntentProfile {
  baseBeat: number;
  beatSpread: number;
  transitionRatio: number;
  gain: number;
  noise: NoiseConfig;
}

const INTENT_PROFILES: Record<CompositionRequest['intent'], IntentProfile> = {
  delta: {
    baseBeat: 2.4,
    beatSpread: 0.45,
    transitionRatio: 0.45,
    gain: 0.82,
    noise: {
      enabled: true,
      volume: 0.055,
      model: 'brown',
    },
  },
  theta: {
    baseBeat: 6,
    beatSpread: 0.65,
    transitionRatio: 0.38,
    gain: 0.91,
    noise: {
      enabled: true,
      volume: 0.05,
      model: 'soft',
    },
  },
  alpha: {
    baseBeat: 10,
    beatSpread: 0.9,
    transitionRatio: 0.32,
    gain: 1,
    noise: {
      enabled: true,
      volume: 0.045,
      model: 'soft',
    },
  },
  beta: {
    baseBeat: 18,
    beatSpread: 1.4,
    transitionRatio: 0.22,
    gain: 0.91,
    noise: {
      enabled: true,
      volume: 0.035,
      model: 'pink',
    },
  },
  mixed: {
    baseBeat: 8,
    beatSpread: 1.25,
    transitionRatio: 0.3,
    gain: 0.91,
    noise: {
      enabled: true,
      volume: 0.045,
      model: 'surf',
    },
  },
};

function createPairId(segmentIndex: number, voiceIndex: number): string {
  return `voice-${voiceIndex + 1}`;
}

function resolveBeat(intent: CompositionRequest['intent'], stepIndex: number, voiceIndex: number, voiceCount: number): number {
  const profile = INTENT_PROFILES[intent];
  const centeredVoice = voiceIndex - (voiceCount - 1) / 2;

  if (intent !== 'mixed') {
    return Math.max(0.1, profile.baseBeat + centeredVoice * profile.beatSpread);
  }

  const cycle = [3.2, 6.4, 10.2, 17.5];
  const base = cycle[stepIndex % cycle.length] ?? profile.baseBeat;
  return Math.max(0.1, base + centeredVoice * 0.75);
}

function distributeVoiceGains(voiceCount: number): number[] {
  const base = [0.82, 0.64, 0.5, 0.38, 0.28];
  return Array.from({ length: voiceCount }, (_, index) => {
    if (index < base.length) {
      return base[index]!;
    }

    return Math.max(0.16, base[base.length - 1]! - (index - base.length + 1) * 0.04);
  });
}

function createSegmentState(
  request: CompositionRequest,
  stepIndex: number,
  frequencies: number[],
): SessionSoundState {
  const profile = INTENT_PROFILES[request.intent];
  const gains = distributeVoiceGains(frequencies.length);

  const pairs: TonePair[] = frequencies.map((carrierHz, voiceIndex) =>
    sanitizeTonePair({
      id: createPairId(stepIndex, voiceIndex),
      carrierHz,
      beatHz: resolveBeat(request.intent, stepIndex, voiceIndex, frequencies.length),
      gain: gains[voiceIndex] ?? 0.24,
    }),
  );

  return sanitizeSessionSoundState({
    pairs,
    gain: profile.gain,
    noise: profile.noise,
  });
}

export function generateSessionPlan(
  request: CompositionRequest,
): GeneratedPlan {
  const steps = parseCompositionSource(request.source);

  if (steps.length === 0) {
    throw new Error('Add at least one note or named chord to generate a timeline.');
  }

  const profile = INTENT_PROFILES[request.intent];
  const session = createSessionDefinition({
    label: request.label.trim() || 'Generated session',
    loop: false,
    metadata: {
      source: 'generated',
      intent: request.intent,
      input: request.source,
    },
    segments: steps.map((step, stepIndex) => {
      const holdDuration = Math.max(
        1,
        Number((request.stepDuration * step.durationMultiplier).toFixed(2)),
      );
      const transitionDuration = Number(
        (holdDuration * profile.transitionRatio).toFixed(2),
      );

      return createSessionSegment({
        id: `segment-${stepIndex + 1}`,
        label: step.label,
        holdDuration,
        transitionDuration,
        state: createSegmentState(request, stepIndex, step.frequencies),
      });
    }),
  });

  return {
    session,
    explanation: [
      `${steps.length} timeline step${steps.length === 1 ? '' : 's'} derived from your note/chord grid.`,
      `${request.intent} intent shaped beat targets, transition pacing, and support noise defaults.`,
      'The generated result is a normal editable timeline session, so you can retune segments and add automation overrides afterward.',
    ],
  };
}
