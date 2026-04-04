import type { TonePair } from '../audio/binauralEngine';

const TAU = Math.PI * 2;

export interface SyntheticSignalOptions {
  sampleCount: number;
  windowSeconds: number;
  centerTimeSeconds: number;
  motionScale?: number;
}

export interface SyntheticSignalFrame {
  left: Float32Array;
  right: Float32Array;
  mono: Float32Array;
  rms: number;
}

export interface SyntheticStftFrame {
  frameCount: number;
  binCount: number;
  magnitudes: Float32Array;
  fftSize: number;
  hopSize: number;
}

export interface LogBandGrid {
  frameCount: number;
  bandCount: number;
  values: Float32Array;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function stableSeedFromId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function clampPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function tonePairChannelHz(pair: TonePair): { leftHz: number; rightHz: number } {
  const split = pair.beatHz / 2;
  return {
    leftHz: Math.max(0.01, pair.carrierHz - split),
    rightHz: Math.max(0.01, pair.carrierHz + split),
  };
}

export function synthesizeStereoSignal(
  pairs: TonePair[],
  options: SyntheticSignalOptions,
): SyntheticSignalFrame {
  const sampleCount = Math.max(8, Math.floor(options.sampleCount));
  const windowSeconds = clampPositive(options.windowSeconds, 5);
  const centerTimeSeconds = Number.isFinite(options.centerTimeSeconds)
    ? options.centerTimeSeconds
    : 0;
  const motionScale = clampPositive(options.motionScale ?? 1, 1);

  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);
  const mono = new Float32Array(sampleCount);
  const audiblePairs = pairs.filter((pair) => pair.gain > 0);

  if (audiblePairs.length === 0) {
    return { left, right, mono, rms: 0 };
  }

  const startSeconds = centerTimeSeconds - windowSeconds / 2;
  const sampleDenominator = Math.max(sampleCount - 1, 1);
  let maxAbs = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const t = startSeconds + (index / sampleDenominator) * windowSeconds;
    let leftValue = 0;
    let rightValue = 0;

    for (const pair of audiblePairs) {
      const seed = stableSeedFromId(pair.id);
      const phaseA = seed * TAU;
      const phaseB = (seed * 0.73 + 0.11) * TAU;
      const beatPhase = TAU * pair.beatHz * (t * motionScale) + phaseA * 0.33;
      const modulation = 0.62 + 0.38 * Math.cos(beatPhase);
      const { leftHz, rightHz } = tonePairChannelHz(pair);

      leftValue +=
        pair.gain *
        modulation *
        Math.sin(TAU * leftHz * (t * motionScale) + phaseA);
      rightValue +=
        pair.gain *
        modulation *
        Math.sin(TAU * rightHz * (t * motionScale) + phaseB);
    }

    left[index] = leftValue;
    right[index] = rightValue;
    mono[index] = (leftValue + rightValue) * 0.5;
    maxAbs = Math.max(maxAbs, Math.abs(leftValue), Math.abs(rightValue), Math.abs(mono[index]!));
  }

  if (maxAbs <= 0) {
    return { left, right, mono, rms: 0 };
  }

  let squareSum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    left[index] /= maxAbs;
    right[index] /= maxAbs;
    mono[index] /= maxAbs;
    squareSum += mono[index]! * mono[index]!;
  }

  return {
    left,
    right,
    mono,
    rms: Math.sqrt(squareSum / sampleCount),
  };
}

function createHannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  const denominator = Math.max(size - 1, 1);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((TAU * index) / denominator);
  }
  return window;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function computeSyntheticStft(
  signal: Float32Array,
  fftSize = 96,
  hopSize = 24,
): SyntheticStftFrame {
  const resolvedFftSize = clampInt(fftSize, 16, 256);
  const resolvedHop = clampInt(hopSize, 4, resolvedFftSize);
  const binCount = Math.floor(resolvedFftSize / 2);

  const paddedLength = Math.max(signal.length, resolvedFftSize);
  const frameCount =
    1 + Math.floor((paddedLength - resolvedFftSize) / resolvedHop);
  const magnitudes = new Float32Array(frameCount * binCount);

  if (signal.length === 0) {
    return {
      frameCount,
      binCount,
      magnitudes,
      fftSize: resolvedFftSize,
      hopSize: resolvedHop,
    };
  }

  const window = createHannWindow(resolvedFftSize);
  let maxMagnitude = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const offset = frameIndex * resolvedHop;

    for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
      let real = 0;
      let imaginary = 0;
      const frequencyFactor = (TAU * binIndex) / resolvedFftSize;

      for (let sampleIndex = 0; sampleIndex < resolvedFftSize; sampleIndex += 1) {
        const inputIndex = offset + sampleIndex;
        const sample =
          (inputIndex < signal.length ? signal[inputIndex]! : 0) *
          window[sampleIndex]!;
        const angle = frequencyFactor * sampleIndex;
        real += sample * Math.cos(angle);
        imaginary -= sample * Math.sin(angle);
      }

      const magnitude = Math.sqrt(real * real + imaginary * imaginary);
      const flatIndex = frameIndex * binCount + binIndex;
      magnitudes[flatIndex] = magnitude;
      maxMagnitude = Math.max(maxMagnitude, magnitude);
    }
  }

  if (maxMagnitude > 0) {
    const compressionBase = Math.log1p(5);
    for (let index = 0; index < magnitudes.length; index += 1) {
      const normalized = magnitudes[index]! / maxMagnitude;
      magnitudes[index] = Math.log1p(normalized * 5) / compressionBase;
    }
  }

  return {
    frameCount,
    binCount,
    magnitudes,
    fftSize: resolvedFftSize,
    hopSize: resolvedHop,
  };
}

export function sampleLogBands(
  stft: SyntheticStftFrame,
  bandCount: number,
): LogBandGrid {
  const resolvedBands = Math.max(4, Math.floor(bandCount));
  const values = new Float32Array(stft.frameCount * resolvedBands);

  if (stft.binCount <= 1) {
    return {
      frameCount: stft.frameCount,
      bandCount: resolvedBands,
      values,
    };
  }

  const minBin = 1;
  const maxBin = stft.binCount - 1;
  const logMin = Math.log(minBin);
  const logRange = Math.log(maxBin) - logMin;

  for (let frameIndex = 0; frameIndex < stft.frameCount; frameIndex += 1) {
    for (let bandIndex = 0; bandIndex < resolvedBands; bandIndex += 1) {
      const ratio = resolvedBands === 1 ? 0 : bandIndex / (resolvedBands - 1);
      const position = Math.exp(logMin + logRange * ratio);
      const lower = Math.floor(position);
      const upper = Math.min(maxBin, Math.ceil(position));
      const blend = position - lower;
      const baseOffset = frameIndex * stft.binCount;

      const lowerValue = stft.magnitudes[baseOffset + lower] ?? 0;
      const upperValue = stft.magnitudes[baseOffset + upper] ?? lowerValue;
      values[frameIndex * resolvedBands + bandIndex] =
        lowerValue + (upperValue - lowerValue) * blend;
    }
  }

  return {
    frameCount: stft.frameCount,
    bandCount: resolvedBands,
    values,
  };
}

