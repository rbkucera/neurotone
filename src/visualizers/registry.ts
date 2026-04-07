import {
  Application,
  BlurFilter,
  ColorMatrixFilter,
  Container,
  Graphics,
} from 'pixi.js';

import type { EngineSnapshot } from '../audio/binauralEngine';
import type { SessionPlaybackState } from '../sequencer/types';
import { visualizerBandOrder, type VisualizerBandActivity } from './bands';
import {
  clamp01,
  computeSyntheticStft,
  sampleLogBands,
  synthesizeStereoSignal,
} from './signal';

const BAND_COLOR: Record<(typeof BAND_SEQUENCE)[number], number> = {
  delta: 0x6f8ecf,
  theta: 0x67b2c8,
  alpha: 0x78bf86,
  beta: 0xd5a56f,
  gamma: 0xc580b6,
};

const BAND_SEQUENCE = ['delta', 'theta', 'alpha', 'beta', 'gamma'] as const;

interface VisualizerPalette {
  backdrop: number;
  backdropAlpha: number;
  haloDock: number;
  haloDockAlpha: number;
}

function getVisualizerPalette(): VisualizerPalette {
  const isDark = document.documentElement.dataset.theme === 'dark';
  return isDark
    ? { backdrop: 0x1a1a1e, backdropAlpha: 0.96, haloDock: 0xffffff, haloDockAlpha: 0.05 }
    : { backdrop: 0xfaf6ef, backdropAlpha: 0.86, haloDock: 0xffffff, haloDockAlpha: 0.12 };
}

export interface VisualizerFrameInput {
  engineState: EngineSnapshot;
  playbackState: SessionPlaybackState;
  durationSeconds: number;
  nowMs: number;
  deltaMs: number;
  intensity: number;
  bandActivity: VisualizerBandActivity;
  isPlaying: boolean;
  width: number;
  height: number;
}

export interface VisualizerScene {
  container: Container;
  resize: (width: number, height: number) => void;
  update: (frame: VisualizerFrameInput) => void;
  destroy: () => void;
}

export interface VisualizerModule {
  id: string;
  label: string;
  createScene: (root: Container) => VisualizerScene;
}

function drawBandHalo(
  graphics: Graphics,
  frame: VisualizerFrameInput,
): void {
  const t = frame.nowMs / 1000;
  const intensity = clamp01(frame.intensity);
  const padding = Math.max(18, Math.min(30, frame.width * 0.022));
  const dockWidth = Math.min(228, Math.max(164, frame.width * 0.24));
  const dockHeight = Math.min(172, Math.max(116, frame.height * 0.23));
  const dockX = Math.max(10, frame.width - dockWidth - padding);
  const dockY = Math.max(10, padding);
  const dockRadius = 18;
  const centerX = dockX + dockWidth * 0.56;
  const centerY = dockY + dockHeight * 0.58;
  const minRingRadius = Math.min(dockWidth, dockHeight) * 0.18;
  const maxRingRadius = Math.min(dockWidth, dockHeight) * 0.38;
  const ringStep =
    BAND_SEQUENCE.length > 1
      ? (maxRingRadius - minRingRadius) / (BAND_SEQUENCE.length - 1)
      : 0;

  graphics.clear();
  const haloPal = getVisualizerPalette();
  graphics
    .roundRect(dockX, dockY, dockWidth, dockHeight, dockRadius)
    .fill({ color: haloPal.haloDock, alpha: haloPal.haloDockAlpha + intensity * 0.05 });
  graphics
    .roundRect(
      dockX + 0.5,
      dockY + 0.5,
      Math.max(0, dockWidth - 1),
      Math.max(0, dockHeight - 1),
      Math.max(0, dockRadius - 0.5),
    )
    .stroke({
      width: 1,
      color: 0x7f6548,
      alpha: 0.2,
    });

  BAND_SEQUENCE.forEach((band, index) => {
    const level = frame.bandActivity.levels[band];
    if (level < 0.06) {
      return;
    }

    const phase = t * (0.11 + index * 0.02);
    const start = -Math.PI * 0.96 + phase + index * 0.14;
    const span = Math.PI * (0.35 + level * 0.4);
    const end = start + span;
    const radius = minRingRadius + index * ringStep;
    const color = BAND_COLOR[band];
    const dominantBoost = frame.bandActivity.dominant === band ? 1.25 : 1;
    const alpha = Math.min(0.78, (0.12 + level * 0.58) * dominantBoost);

    const startX = centerX + Math.cos(start) * radius;
    const startY = centerY + Math.sin(start) * radius;
    graphics
      .moveTo(startX, startY)
      .arc(centerX, centerY, radius, start, end)
      .stroke({
        width: 1.2 + level * 1.6 * dominantBoost,
        color,
        alpha,
      });
  });
}

function traceSignalPath(
  graphics: Graphics,
  values: Float32Array,
  width: number,
  midY: number,
  amplitude: number,
): void {
  if (values.length === 0) {
    return;
  }

  graphics.moveTo(0, midY - values[0]! * amplitude);
  const denominator = Math.max(values.length - 1, 1);
  for (let index = 1; index < values.length; index += 1) {
    const x = (index / denominator) * width;
    const y = midY - values[index]! * amplitude;
    graphics.lineTo(x, y);
  }
}

function strokeSignalPath(
  graphics: Graphics,
  values: Float32Array,
  width: number,
  midY: number,
  amplitude: number,
  style: {
    width: number;
    color: number;
    alpha: number;
  },
): void {
  if (values.length === 0) {
    return;
  }
  traceSignalPath(graphics, values, width, midY, amplitude);
  graphics.stroke(style);
}

function playbackCenterSeconds(playbackState: SessionPlaybackState): number {
  return Number.isFinite(playbackState.totalElapsed)
    ? playbackState.totalElapsed
    : 0;
}

function createEnvelopeFieldScene(): (root: Container) => VisualizerScene {
  return (_root) => {
    const container = new Container();

    const background = new Graphics();
    const haze = new Graphics();
    const ribbonLow = new Graphics();
    const ribbonMid = new Graphics();
    const ribbonHigh = new Graphics();
    const halo = new Graphics();
    ribbonLow.filters = [new BlurFilter({ strength: 8 })];
    ribbonMid.filters = [new BlurFilter({ strength: 4 })];
    const grade = new ColorMatrixFilter();
    grade.brightness(1.02, false);
    container.filters = [grade];

    container.addChild(background, haze, ribbonLow, ribbonMid, ribbonHigh, halo);

    let width = 0;
    let height = 0;
    let smoothed = new Float32Array(0);

    const resize = (nextWidth: number, nextHeight: number): void => {
      width = nextWidth;
      height = nextHeight;
      if (smoothed.length !== Math.max(220, Math.floor(width * 0.95))) {
        smoothed = new Float32Array(Math.max(220, Math.floor(width * 0.95)));
      }
    };

    const update = (frame: VisualizerFrameInput): void => {
      const intensity = clamp01(frame.intensity);
      const sampleCount = Math.max(220, Math.floor(width * 0.95));
      const signal = synthesizeStereoSignal(frame.engineState.pairs, {
        sampleCount,
        windowSeconds: Math.max(4.6, frame.durationSeconds * 1.08),
        centerTimeSeconds: playbackCenterSeconds(frame.playbackState),
        motionScale: 0.86,
      });

      if (smoothed.length !== signal.mono.length) {
        smoothed = new Float32Array(signal.mono.length);
      }
      {
        const alpha = frame.isPlaying
          ? 0.16 + intensity * 0.12
          : 0.08;
        for (let index = 0; index < smoothed.length; index += 1) {
          const target = frame.isPlaying ? signal.mono[index]! : 0;
          smoothed[index] = smoothed[index]! * (1 - alpha) + target * alpha;
        }
      }

      const pal = getVisualizerPalette();
      background.clear();
      background.rect(0, 0, width, height).fill({ color: pal.backdrop, alpha: pal.backdropAlpha });

      const centerY = height * 0.52;
      const baseAmplitude = height * (0.24 + intensity * 0.12);

      ribbonLow.clear();
      strokeSignalPath(ribbonLow, smoothed, width, centerY, baseAmplitude * 0.96, {
        width: 8 + intensity * 2,
        color: 0x7ca4bc,
        alpha: 0.2,
      });

      ribbonMid.clear();
      strokeSignalPath(ribbonMid, smoothed, width, centerY, baseAmplitude, {
        width: 4 + intensity * 1.5,
        color: 0xb88c63,
        alpha: 0.38,
      });

      ribbonHigh.clear();
      strokeSignalPath(ribbonHigh, smoothed, width, centerY, baseAmplitude * 1.02, {
        width: 1.75,
        color: 0x91562b,
        alpha: 0.82,
      });

      haze.clear();
      haze
        .rect(0, height * 0.1, width, height * 0.82)
        .fill({ color: 0xb59a7d, alpha: 0.06 + intensity * 0.03 });

      drawBandHalo(halo, frame);
    };

    return {
      container,
      resize,
      update,
      destroy: () => {
        container.removeChildren();
      },
    };
  };
}

function createStereoDriftRibbonsScene(): (root: Container) => VisualizerScene {
  return (_root) => {
    const container = new Container();

    const backdrop = new Graphics();
    const wash = new Graphics();
    const trailLeft = new Graphics();
    const trailRight = new Graphics();
    const ribbonLeft = new Graphics();
    const ribbonRight = new Graphics();
    const centerLine = new Graphics();
    const halo = new Graphics();

    trailLeft.filters = [new BlurFilter({ strength: 3.2 })];
    trailRight.filters = [new BlurFilter({ strength: 3.2 })];
    wash.filters = [new BlurFilter({ strength: 2.2 })];
    container.addChild(
      backdrop,
      wash,
      trailLeft,
      trailRight,
      ribbonLeft,
      ribbonRight,
      centerLine,
      halo,
    );

    let width = 0;
    let height = 0;
    let smoothedLeft = new Float32Array(0);
    let smoothedRight = new Float32Array(0);
    let smoothedMid = new Float32Array(0);

    const resize = (nextWidth: number, nextHeight: number): void => {
      width = nextWidth;
      height = nextHeight;
    };

    const update = (frame: VisualizerFrameInput): void => {
      const intensity = clamp01(frame.intensity);
      const signal = synthesizeStereoSignal(frame.engineState.pairs, {
        sampleCount: Math.max(420, Math.floor(width * 1.35)),
        windowSeconds: 4.4,
        centerTimeSeconds: playbackCenterSeconds(frame.playbackState),
        motionScale: 0.78,
      });
      if (smoothedLeft.length !== signal.left.length) {
        smoothedLeft = new Float32Array(signal.left.length);
        smoothedRight = new Float32Array(signal.left.length);
        smoothedMid = new Float32Array(signal.left.length);
      }
      {
        const temporalAlpha = frame.isPlaying
          ? 0.14 + intensity * 0.12
          : 0.08;
        for (let index = 0; index < signal.left.length; index += 1) {
          if (frame.isPlaying) {
            const leftPrev = index > 0 ? signal.left[index - 1]! : signal.left[index]!;
            const leftNext =
              index < signal.left.length - 1 ? signal.left[index + 1]! : signal.left[index]!;
            const rightPrev = index > 0 ? signal.right[index - 1]! : signal.right[index]!;
            const rightNext =
              index < signal.right.length - 1 ? signal.right[index + 1]! : signal.right[index]!;
            const leftSpatial = leftPrev * 0.2 + signal.left[index]! * 0.6 + leftNext * 0.2;
            const rightSpatial = rightPrev * 0.2 + signal.right[index]! * 0.6 + rightNext * 0.2;
            smoothedLeft[index] =
              smoothedLeft[index]! * (1 - temporalAlpha) + leftSpatial * temporalAlpha;
            smoothedRight[index] =
              smoothedRight[index]! * (1 - temporalAlpha) + rightSpatial * temporalAlpha;
          } else {
            smoothedLeft[index] = smoothedLeft[index]! * (1 - temporalAlpha);
            smoothedRight[index] = smoothedRight[index]! * (1 - temporalAlpha);
          }
        }
      }

      const pal = getVisualizerPalette();
      backdrop.clear();
      backdrop.rect(0, 0, width, height).fill({ color: pal.backdrop, alpha: pal.backdropAlpha });

      const drift = Math.sin(frame.nowMs / 7800) * height * 0.024;
      const spread = height * (0.34 + intensity * 0.1);
      const centerY = height * 0.5;
      const leftMid = centerY - spread * 0.5 + drift;
      const rightMid = centerY + spread * 0.5 - drift;
      const amplitude = height * (0.205 + intensity * 0.155);

      wash.clear();
      wash
        .rect(0, height * 0.08, width, height * 0.84)
        .fill({ color: 0xc9e0dc, alpha: 0.06 + intensity * 0.07 });

      trailLeft.clear();
      strokeSignalPath(trailLeft, smoothedLeft, width, leftMid, amplitude * 1.05, {
        width: 7.5 + intensity * 2.5,
        color: 0x74b0bc,
        alpha: 0.18 + intensity * 0.09,
      });

      trailRight.clear();
      strokeSignalPath(trailRight, smoothedRight, width, rightMid, amplitude * 0.98, {
        width: 7.5 + intensity * 2.5,
        color: 0xa790d4,
        alpha: 0.15 + intensity * 0.08,
      });

      ribbonLeft.clear();
      strokeSignalPath(ribbonLeft, smoothedLeft, width, leftMid, amplitude, {
        width: 2.4 + intensity * 1.05,
        color: 0x5f98a3,
        alpha: 0.64 + intensity * 0.16,
      });

      ribbonRight.clear();
      strokeSignalPath(ribbonRight, smoothedRight, width, rightMid, amplitude * 0.96, {
        width: 2.2 + intensity * 1.05,
        color: 0x8772b5,
        alpha: 0.6 + intensity * 0.15,
      });

      centerLine.clear();
      for (let index = 0; index < smoothedMid.length; index += 1) {
        smoothedMid[index] = (smoothedLeft[index]! + smoothedRight[index]!) * 0.5;
      }
      strokeSignalPath(centerLine, smoothedMid, width, centerY, amplitude * 0.5, {
        width: 1.2,
        color: 0x99653d,
        alpha: 0.18 + intensity * 0.1,
      });

      drawBandHalo(halo, frame);
    };

    return {
      container,
      resize,
      update,
      destroy: () => {
        container.removeChildren();
      },
    };
  };
}

function createSpectralAuroraScene(): (root: Container) => VisualizerScene {
  return (_root) => {
    const container = new Container();

    const backdrop = new Graphics();
    const ribbons = new Graphics();
    const accents = new Graphics();
    const haze = new Graphics();
    const halo = new Graphics();
    ribbons.filters = [new BlurFilter({ strength: 3.4 })];
    accents.filters = [new BlurFilter({ strength: 1.2 })];
    container.addChild(backdrop, ribbons, accents, haze, halo);

    let width = 0;
    let height = 0;
    let smoothedBands = new Float32Array(0);
    let smoothedFrames = 0;
    let smoothedBandCount = 0;

    const resize = (nextWidth: number, nextHeight: number): void => {
      width = nextWidth;
      height = nextHeight;
    };

    const update = (frame: VisualizerFrameInput): void => {
      const intensity = clamp01(frame.intensity);
      const signal = synthesizeStereoSignal(frame.engineState.pairs, {
        sampleCount: Math.max(2176, Math.floor(width * 2.4)),
        windowSeconds: 1.35,
        centerTimeSeconds: playbackCenterSeconds(frame.playbackState),
        motionScale: 0.86,
      });
      const stft = computeSyntheticStft(signal.mono, 96, 12);
      const bands = sampleLogBands(stft, 42);

      if (
        smoothedBands.length !== bands.values.length ||
        smoothedFrames !== bands.frameCount ||
        smoothedBandCount !== bands.bandCount
      ) {
        smoothedBands = new Float32Array(bands.values.length);
        smoothedFrames = bands.frameCount;
        smoothedBandCount = bands.bandCount;
      }
      {
        const alpha = frame.isPlaying
          ? 0.22 + intensity * 0.18
          : 0.08;
        for (let index = 0; index < smoothedBands.length; index += 1) {
          const target = frame.isPlaying ? bands.values[index]! : 0;
          smoothedBands[index] =
            smoothedBands[index]! * (1 - alpha) + target * alpha;
        }
      }

      const pal = getVisualizerPalette();
      backdrop.clear();
      backdrop.rect(0, 0, width, height).fill({ color: pal.backdrop, alpha: pal.backdropAlpha });

      ribbons.clear();
      accents.clear();

      const frameSpan = Math.max(bands.frameCount - 1, 1);
      const bandSpan = Math.max(bands.bandCount - 1, 1);
      const top = height * 0.08;
      const bottom = height * 0.94;
      const drawable = Math.max(20, bottom - top);
      const columnStep = width / frameSpan;
      const enhanced = new Float32Array(bands.values.length);
      const bandPresence = new Float32Array(bands.bandCount);

      for (let frameIndex = 0; frameIndex < bands.frameCount; frameIndex += 1) {
        for (let bandIndex = 0; bandIndex < bands.bandCount; bandIndex += 1) {
          const baseIndex = frameIndex * bands.bandCount + bandIndex;
          const bandRatio = bandIndex / bandSpan;
          const center = smoothedBands[baseIndex] ?? 0;
          const prev = bandIndex > 0 ? (smoothedBands[baseIndex - 1] ?? center) : center;
          const next =
            bandIndex < bands.bandCount - 1
              ? (smoothedBands[baseIndex + 1] ?? center)
              : center;
          const spread = prev * 0.24 + center * 0.52 + next * 0.24;
          const tilt = 0.72 + bandRatio * 2.1;
          const boosted = Math.min(
            1,
            Math.pow(Math.max(0, spread * tilt), 0.62) * (1.1 + intensity * 1.15),
          );
          enhanced[baseIndex] = boosted;
          bandPresence[bandIndex] += boosted;
        }
      }

      for (let bandIndex = 0; bandIndex < bandPresence.length; bandIndex += 1) {
        bandPresence[bandIndex] = bandPresence[bandIndex]! / Math.max(1, bands.frameCount);
      }

      for (let bandIndex = 0; bandIndex < bands.bandCount; bandIndex += 1) {
        const bandRatio = bandIndex / bandSpan;
        const color = BAND_COLOR[BAND_SEQUENCE[bandIndex % BAND_SEQUENCE.length]];
        const presence = Math.min(1, bandPresence[bandIndex]! * 1.6);
        const floorLift = presence * (0.18 + intensity * 0.16);
        const baseY = bottom - bandRatio * drawable;

        for (let frameIndex = 0; frameIndex < bands.frameCount; frameIndex += 1) {
          const lifted = Math.max(
            floorLift,
            enhanced[frameIndex * bands.bandCount + bandIndex] ?? floorLift,
          );
          const x = frameIndex * columnStep;
          const y = baseY - lifted * (20 + intensity * 34);
          if (frameIndex === 0) {
            ribbons.moveTo(x, y);
            accents.moveTo(x, y);
          } else {
            ribbons.lineTo(x, y);
            accents.lineTo(x, y);
          }
        }
        ribbons.stroke({
          width: 2.2 + intensity * 2.6,
          color,
          alpha: 0.17 + presence * 0.46,
        });
        accents.stroke({
          width: 1.1 + intensity * 0.8,
          color,
          alpha: 0.2 + presence * 0.58,
        });
      }

      haze.clear();
      haze
        .rect(0, top, width, drawable)
        .fill({ color: 0xcfe5dc, alpha: 0.09 + intensity * 0.08 });

      drawBandHalo(halo, frame);
    };

    return {
      container,
      resize,
      update,
      destroy: () => {
        container.removeChildren();
      },
    };
  };
}

const envelopeVisualizer: VisualizerModule = {
  id: 'envelope',
  label: 'Envelope Field',
  createScene: createEnvelopeFieldScene(),
};

const stereoBloomOrbVisualizer: VisualizerModule = {
  id: 'stereo-bloom-orb',
  label: 'Stereo Drift Ribbons',
  createScene: createStereoDriftRibbonsScene(),
};

const spectralAuroraVisualizer: VisualizerModule = {
  id: 'spectral-aurora',
  label: 'Spectral Aurora',
  createScene: createSpectralAuroraScene(),
};

export const VISUALIZER_REGISTRY: VisualizerModule[] = [
  envelopeVisualizer,
  stereoBloomOrbVisualizer,
  spectralAuroraVisualizer,
];

export const DEFAULT_VISUALIZER_ID = stereoBloomOrbVisualizer.id;

export function getVisualizerModule(moduleId: string): VisualizerModule {
  return (
    VISUALIZER_REGISTRY.find((module) => module.id === moduleId) ??
    envelopeVisualizer
  );
}

export class PixiVisualizerRuntime {
  private readonly root: Container;

  private activeModuleId: string | null = null;

  private activeScene: VisualizerScene | null = null;

  private width: number;

  private height: number;

  private constructor(
    private readonly app: Application,
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
    this.root = new Container();
    this.app.stage.addChild(this.root);
  }

  static async create(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
  ): Promise<PixiVisualizerRuntime> {
    const tryInitWebGl = async (): Promise<Application | null> => {
      const app = new Application();
      try {
        await app.init({
          canvas,
          width,
          height,
          antialias: true,
          autoDensity: true,
          backgroundAlpha: 0,
          autoStart: false,
          preference: 'webgl',
        });
        return app;
      } catch {
        try {
          app.destroy(false, {
            children: true,
            texture: false,
            textureSource: false,
            context: true,
          });
        } catch {
          // Some PIXI init failures occur before internal resize hooks exist.
          // In that case, ignore destroy errors and continue to next renderer fallback.
        }
        return null;
      }
    };

    const app = await tryInitWebGl();
    if (!app) {
      throw new Error('Unable to initialize PIXI WebGL renderer.');
    }
    return new PixiVisualizerRuntime(app, width, height);
  }

  private setModule(moduleId: string): void {
    if (this.activeModuleId === moduleId && this.activeScene) {
      return;
    }

    if (this.activeScene) {
      this.activeScene.destroy();
      this.root.removeChild(this.activeScene.container);
      this.activeScene = null;
    }

    const module = getVisualizerModule(moduleId);
    const scene = module.createScene(this.root);
    this.activeScene = scene;
    this.activeModuleId = moduleId;
    this.root.addChild(scene.container);
    scene.resize(this.width, this.height);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = width;
    this.height = height;
    this.app.renderer.resize(width, height);
    this.activeScene?.resize(width, height);
  }

  render(moduleId: string, frame: Omit<VisualizerFrameInput, 'width' | 'height'>): void {
    this.setModule(moduleId);
    if (!this.activeScene) {
      return;
    }

    this.activeScene.update({
      ...frame,
      width: this.width,
      height: this.height,
    });
    this.app.render();
  }

  destroy(): void {
    if (this.activeScene) {
      this.activeScene.destroy();
      this.root.removeChild(this.activeScene.container);
      this.activeScene = null;
    }
    this.app.destroy(false, {
      children: true,
      texture: false,
      textureSource: false,
      context: true,
    });
  }
}

export function bandOrder(): readonly (typeof BAND_SEQUENCE)[number][] {
  return visualizerBandOrder();
}
