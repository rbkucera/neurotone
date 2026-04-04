import type { EngineSnapshot } from '../audio/binauralEngine';
import { computeEnvelope } from '../audio/visualization';
import type { SessionPlaybackState } from '../sequencer/types';

export interface VisualizerFrameInput {
  canvas: HTMLCanvasElement;
  engineState: EngineSnapshot;
  playbackState: SessionPlaybackState;
  durationSeconds: number;
}

export interface VisualizerModule {
  id: string;
  label: string;
  renderFrame: (input: VisualizerFrameInput) => void;
}

interface EnvelopeZenProfile {
  spatialSmoothing: number;
}

const ENVELOPE_ZEN_GENTLE: EnvelopeZenProfile = {
  spatialSmoothing: 0.08,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function applySpatialSmoothing(
  source: Float32Array,
  amount: number,
): Float32Array {
  const blend = clamp01(amount);
  if (source.length <= 2 || blend <= 0) {
    return source.slice();
  }

  const kernelCenter = 0.6;
  const kernelEdge = 0.2;
  const smoothed = new Float32Array(source.length);
  smoothed[0] = source[0]!;
  smoothed[source.length - 1] = source[source.length - 1]!;

  for (let index = 1; index < source.length - 1; index += 1) {
    const filtered =
      source[index - 1]! * kernelEdge +
      source[index]! * kernelCenter +
      source[index + 1]! * kernelEdge;
    smoothed[index] = source[index]! + (filtered - source[index]!) * blend;
  }

  return smoothed;
}

function buildPathPoints(
  samples: Float32Array,
  width: number,
  midY: number,
  amplitude: number,
): Array<{ x: number; y: number }> {
  return Array.from({ length: samples.length }, (_, index) => ({
    x: (index / Math.max(samples.length - 1, 1)) * width,
    y: midY - samples[index]! * amplitude,
  }));
}

function drawSmoothPath(
  context: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  if (points.length === 0) {
    return;
  }
  if (points.length === 1) {
    context.moveTo(points[0]!.x, points[0]!.y);
    context.lineTo(points[0]!.x + 0.01, points[0]!.y);
    return;
  }

  context.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    context.quadraticCurveTo(current.x, current.y, midX, midY);
  }
  const last = points[points.length - 1]!;
  context.lineTo(last.x, last.y);
}

function drawZenEnvelope(
  canvas: HTMLCanvasElement,
  samples: Float32Array,
): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  const midY = height / 2;
  const amplitude = midY * 0.8;
  const points = buildPathPoints(samples, width, midY, amplitude);

  context.clearRect(0, 0, width, height);
  context.fillStyle = 'rgba(157, 94, 47, 0.045)';
  context.fillRect(0, 0, width, height);

  context.beginPath();
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.strokeStyle = 'rgba(157, 94, 47, 0.18)';
  context.lineWidth = 3;
  context.shadowColor = 'rgba(157, 94, 47, 0.16)';
  context.shadowBlur = 5;
  drawSmoothPath(context, points);
  context.stroke();

  context.beginPath();
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.strokeStyle = '#9d5e2f';
  context.lineWidth = 1.45;
  context.shadowColor = 'transparent';
  context.shadowBlur = 0;
  drawSmoothPath(context, points);
  context.stroke();
}

const envelopeVisualizer: VisualizerModule = {
  id: 'envelope',
  label: 'Envelope',
  renderFrame: (input) => {
    const width = Math.max(360, Math.floor(input.canvas.clientWidth || 860));
    if (input.canvas.width !== width) {
      input.canvas.width = width;
    }
    input.canvas.height = 280;

    const samples = computeEnvelope(
      input.engineState.pairs,
      input.durationSeconds,
      width,
    );

    const spatialSamples = applySpatialSmoothing(
      samples,
      ENVELOPE_ZEN_GENTLE.spatialSmoothing,
    );
    drawZenEnvelope(input.canvas, spatialSamples);
  },
};

// Add new visualizers here to expose additional render modules in the UI.
export const VISUALIZER_REGISTRY: VisualizerModule[] = [envelopeVisualizer];

export const DEFAULT_VISUALIZER_ID = envelopeVisualizer.id;

export function getVisualizerModule(
  moduleId: string,
): VisualizerModule {
  return (
    VISUALIZER_REGISTRY.find((module) => module.id === moduleId) ??
    envelopeVisualizer
  );
}
