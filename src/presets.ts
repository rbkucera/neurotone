import { sanitizeTonePair } from './audio/binauralEngine';
import type { ShareableState } from './sessionState';
import { normalizeShareableState } from './sessionState';
import { createSessionDefinition, createSessionSegment, sanitizeSessionSoundState } from './sequencer/utils';

export interface PresetDefinition {
  id: string;
  label: string;
  description: string;
  state: ShareableState;
}

function createPresetState(
  presetId: string,
  label: string,
  input: Parameters<typeof sanitizeSessionSoundState>[0],
): ShareableState {
  const session = createSessionDefinition({
    label,
    loop: false,
    metadata: {
      source: 'manual',
    },
    segments: [
      createSessionSegment({
        id: `${presetId}-segment-1`,
        label: 'Segment 1',
        holdDuration: 18,
        transitionDuration: 0,
        state: sanitizeSessionSoundState(input),
      }),
    ],
  });

  return normalizeShareableState({
    presetId,
    session,
  });
}

export const presets: PresetDefinition[] = [
  {
    id: 'clear-focus',
    label: 'Clear Focus',
    description: 'Single alpha layer with a light, quiet floor.',
    state: createPresetState('clear-focus', 'Clear Focus', {
      pairs: [
        sanitizeTonePair({
          id: 'clear-focus-a',
          carrierHz: 200,
          beatHz: 10,
          gain: 0.9,
        }),
      ],
      gain: 1,
      noise: {
        enabled: false,
        volume: 0.05,
        model: 'soft',
      },
    }),
  },
  {
    id: 'layered-balance',
    label: 'Layered Balance',
    description: 'Alpha on top of a lower grounding layer.',
    state: createPresetState('layered-balance', 'Layered Balance', {
      pairs: [
        sanitizeTonePair({
          id: 'layered-balance-a',
          carrierHz: 200,
          beatHz: 10,
          gain: 0.7,
        }),
        sanitizeTonePair({
          id: 'layered-balance-b',
          carrierHz: 43,
          beatHz: 3,
          gain: 0.46,
        }),
      ],
      gain: 0.91,
      noise: {
        enabled: true,
        volume: 0.05,
        model: 'soft',
      },
    }),
  },
  {
    id: 'soft-arrival',
    label: 'Soft Arrival',
    description: 'A gentler opening state for calm settling.',
    state: createPresetState('soft-arrival', 'Soft Arrival', {
      pairs: [
        sanitizeTonePair({
          id: 'soft-arrival-a',
          carrierHz: 180,
          beatHz: 8,
          gain: 0.72,
        }),
        sanitizeTonePair({
          id: 'soft-arrival-b',
          carrierHz: 96,
          beatHz: 2.6,
          gain: 0.36,
        }),
      ],
      gain: 0.82,
      noise: {
        enabled: true,
        volume: 0.04,
        model: 'brown',
      },
    }),
  },
];

export function getPresetById(id: string): PresetDefinition | undefined {
  return presets.find((preset) => preset.id === id);
}
