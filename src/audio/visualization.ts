import type { TonePair } from './binauralEngine';

export type BrainwaveBand =
  | 'delta'
  | 'theta'
  | 'alpha'
  | 'beta'
  | 'gamma'
  | 'unknown';

export type BeatEntryType =
  | 'designed'
  | 'carrier-interference'
  | 'second-order';

export interface BeatEntry {
  label: string;
  frequencyHz: number;
  band: BrainwaveBand;
  type: BeatEntryType;
  layerIds: string[];
}

function normalizeTonePairs(pairs: TonePair[]): TonePair[] {
  return pairs.filter((pair) => pair.gain > 0);
}

export function classifyBand(hz: number): BrainwaveBand {
  if (hz < 4) {
    return 'delta';
  }
  if (hz < 8) {
    return 'theta';
  }
  if (hz < 13) {
    return 'alpha';
  }
  if (hz < 30) {
    return 'beta';
  }
  if (hz < 100) {
    return 'gamma';
  }

  return 'unknown';
}

export function computeBeatMap(pairs: TonePair[]): BeatEntry[] {
  const activePairs = normalizeTonePairs(pairs);
  const beats: BeatEntry[] = [];

  for (const pair of activePairs) {
    beats.push({
      label: `Layer (${pair.carrierHz} Hz carrier)`,
      frequencyHz: pair.beatHz,
      band: classifyBand(pair.beatHz),
      type: 'designed',
      layerIds: [pair.id],
    });
  }

  for (let a = 0; a < activePairs.length; a += 1) {
    for (let b = a + 1; b < activePairs.length; b += 1) {
      const interferenceHz = Math.abs(
        activePairs[a].carrierHz - activePairs[b].carrierHz,
      );

      if (interferenceHz <= 0) {
        continue;
      }

      beats.push({
        label: `Layer ${a + 1} × Layer ${b + 1} carrier gap`,
        frequencyHz: interferenceHz,
        band: classifyBand(interferenceHz),
        type: 'carrier-interference',
        layerIds: [activePairs[a].id, activePairs[b].id],
      });
    }
  }

  const designedBeats = beats.filter((entry) => entry.type === 'designed');
  for (let a = 0; a < designedBeats.length; a += 1) {
    for (let b = a + 1; b < designedBeats.length; b += 1) {
      const differenceHz = Math.abs(
        designedBeats[a].frequencyHz - designedBeats[b].frequencyHz,
      );
      const sumHz =
        designedBeats[a].frequencyHz + designedBeats[b].frequencyHz;

      if (differenceHz > 0.1) {
        beats.push({
          label: 'Beat difference',
          frequencyHz: differenceHz,
          band: classifyBand(differenceHz),
          type: 'second-order',
          layerIds: [
            ...designedBeats[a].layerIds,
            ...designedBeats[b].layerIds,
          ],
        });
      }

      beats.push({
        label: 'Beat sum',
        frequencyHz: sumHz,
        band: classifyBand(sumHz),
        type: 'second-order',
        layerIds: [
          ...designedBeats[a].layerIds,
          ...designedBeats[b].layerIds,
        ],
      });
    }
  }

  return beats.sort((left, right) => left.frequencyHz - right.frequencyHz);
}

export function computeEnvelope(
  pairs: TonePair[],
  durationSeconds: number,
  sampleCount: number,
): Float32Array {
  const activePairs = normalizeTonePairs(pairs);
  const samples = new Float32Array(sampleCount);

  if (activePairs.length === 0 || sampleCount <= 0 || durationSeconds <= 0) {
    return samples;
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const t = (index / sampleCount) * durationSeconds;
    let value = 0;

    for (const pair of activePairs) {
      value += pair.gain * Math.cos(2 * Math.PI * pair.beatHz * t);
    }

    for (let a = 0; a < activePairs.length; a += 1) {
      for (let b = a + 1; b < activePairs.length; b += 1) {
        const interferenceHz = Math.abs(
          activePairs[a].carrierHz - activePairs[b].carrierHz,
        );

        if (interferenceHz <= 0) {
          continue;
        }

        const interferenceGain =
          ((activePairs[a].gain + activePairs[b].gain) / 2) * 0.5;

        value +=
          interferenceGain * Math.cos(2 * Math.PI * interferenceHz * t);
      }
    }

    samples[index] = value;
  }

  let maxMagnitude = 0;
  for (const sample of samples) {
    maxMagnitude = Math.max(maxMagnitude, Math.abs(sample));
  }

  if (maxMagnitude > 0) {
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] /= maxMagnitude;
    }
  }

  return samples;
}

export function drawEnvelope(
  canvas: HTMLCanvasElement,
  samples: Float32Array,
  playheadProgress: number,
): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  const midY = height / 2;

  context.clearRect(0, 0, width, height);

  context.fillStyle = 'rgba(157, 94, 47, 0.06)';
  context.fillRect(0, 0, width, height);

  context.beginPath();
  context.strokeStyle = '#9d5e2f';
  context.lineWidth = 2;

  for (let index = 0; index < samples.length; index += 1) {
    const x = (index / Math.max(samples.length - 1, 1)) * width;
    const y = midY - samples[index] * (midY * 0.82);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  context.stroke();

  const clampedProgress = Math.min(1, Math.max(0, playheadProgress));
  const playheadX = clampedProgress * width;
  context.beginPath();
  context.strokeStyle = 'rgba(127, 67, 25, 0.45)';
  context.lineWidth = 1.5;
  context.moveTo(playheadX, 0);
  context.lineTo(playheadX, height);
  context.stroke();
}
