import type { BeatEntry } from '../audio/visualization';

export type VisualizerBand = 'delta' | 'theta' | 'alpha' | 'beta' | 'gamma';

export interface VisualizerBandActivity {
  levels: Record<VisualizerBand, number>;
  dominant: VisualizerBand | null;
  activeBands: VisualizerBand[];
}

const VISUALIZER_BANDS: VisualizerBand[] = [
  'delta',
  'theta',
  'alpha',
  'beta',
  'gamma',
];

const TYPE_WEIGHT: Record<BeatEntry['type'], number> = {
  designed: 1,
  'carrier-interference': 0.5,
  'second-order': 0.3,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function emptyLevels(): Record<VisualizerBand, number> {
  return {
    delta: 0,
    theta: 0,
    alpha: 0,
    beta: 0,
    gamma: 0,
  };
}

export function createEmptyBandActivity(): VisualizerBandActivity {
  return {
    levels: emptyLevels(),
    dominant: null,
    activeBands: [],
  };
}

function computeRawLevels(entries: BeatEntry[]): Record<VisualizerBand, number> {
  const raw = emptyLevels();

  for (const entry of entries) {
    if (!VISUALIZER_BANDS.includes(entry.band as VisualizerBand)) {
      continue;
    }

    const band = entry.band as VisualizerBand;
    const frequencyWeight = clamp01(1 - Math.min(entry.frequencyHz, 60) / 90);
    const weightedScore = TYPE_WEIGHT[entry.type] * (0.65 + frequencyWeight * 0.35);
    raw[band] += weightedScore;
  }

  const maxValue = Math.max(...VISUALIZER_BANDS.map((band) => raw[band]));
  if (maxValue > 0) {
    VISUALIZER_BANDS.forEach((band) => {
      raw[band] = clamp01(raw[band] / maxValue);
    });
  }

  return raw;
}

export function advanceBandActivity(
  previous: VisualizerBandActivity,
  entries: BeatEntry[],
  alpha = 0.2,
): VisualizerBandActivity {
  const blend = clamp01(alpha);
  const raw = computeRawLevels(entries);
  const levels = emptyLevels();

  VISUALIZER_BANDS.forEach((band) => {
    levels[band] = clamp01(
      previous.levels[band] * (1 - blend) + raw[band] * blend,
    );
  });

  let dominant: VisualizerBand | null = null;
  let dominantValue = 0;
  const activeBands: VisualizerBand[] = [];

  VISUALIZER_BANDS.forEach((band) => {
    const value = levels[band];
    if (value > 0.28) {
      activeBands.push(band);
    }
    if (value > dominantValue) {
      dominantValue = value;
      dominant = band;
    }
  });

  if (dominantValue < 0.12) {
    dominant = null;
  }

  return {
    levels,
    dominant,
    activeBands,
  };
}

export function visualizerBandOrder(): readonly VisualizerBand[] {
  return VISUALIZER_BANDS;
}

