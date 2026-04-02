export type PlaybackState = 'idle' | 'running' | 'stopped';

export interface TonePair {
  id: string;
  carrierHz: number;
  beatHz: number;
  gain: number;
}

export interface TonePairSnapshot extends TonePair {
  leftHz: number;
  rightHz: number;
}

export interface NoiseConfig {
  enabled: boolean;
  volume: number;
}

export interface BaseParams {
  pairs: TonePair[];
  masterGain: number;
}

export interface EngineSnapshot {
  playbackState: PlaybackState;
  pairs: TonePairSnapshot[];
  base: BaseParams;
  noise: NoiseConfig;
}

export interface TonePairInput extends Partial<Omit<TonePair, 'id'>> {
  id?: string;
}

const DEFAULT_PAIR = {
  carrierHz: 200,
  beatHz: 10,
  gain: 1,
} satisfies Omit<TonePair, 'id'>;

const DEFAULT_NOISE: NoiseConfig = {
  enabled: false,
  volume: 0.06,
};

const DEFAULT_MASTER_GAIN = 0.22;

const LIMITS = {
  carrierMin: 20,
  carrierMax: 1200,
  beatMin: 0.1,
  beatMax: 40,
  gainMin: 0,
  gainMax: 1,
  rampSeconds: 0.035,
  transportFadeSeconds: 0.3,
  noiseFloor: 0.0001,
  suspendDelayMs: 420,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createTonePairId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `pair-${Math.random().toString(36).slice(2, 10)}`;
}

export function sanitizeTonePair(input: TonePairInput = {}): TonePair {
  return {
    id: input.id ?? createTonePairId(),
    carrierHz: clamp(
      input.carrierHz ?? DEFAULT_PAIR.carrierHz,
      LIMITS.carrierMin,
      LIMITS.carrierMax,
    ),
    beatHz: clamp(
      input.beatHz ?? DEFAULT_PAIR.beatHz,
      LIMITS.beatMin,
      LIMITS.beatMax,
    ),
    gain: clamp(input.gain ?? DEFAULT_PAIR.gain, LIMITS.gainMin, LIMITS.gainMax),
  };
}

export function sanitizeNoiseConfig(
  input: Partial<NoiseConfig> = {},
): NoiseConfig {
  return {
    enabled: input.enabled ?? DEFAULT_NOISE.enabled,
    volume: clamp(
      input.volume ?? DEFAULT_NOISE.volume,
      LIMITS.gainMin,
      LIMITS.gainMax,
    ),
  };
}

export function computeChannelFrequencies(
  carrierHz: number,
  beatHz: number,
): { leftHz: number; rightHz: number } {
  const sanitizedCarrier = clamp(
    carrierHz,
    LIMITS.carrierMin,
    LIMITS.carrierMax,
  );
  const sanitizedBeat = clamp(beatHz, LIMITS.beatMin, LIMITS.beatMax);
  const halfBeat = sanitizedBeat / 2;

  return {
    leftHz: sanitizedCarrier - halfBeat,
    rightHz: sanitizedCarrier + halfBeat,
  };
}

export function computeTonePairSnapshot(pair: TonePair): TonePairSnapshot {
  return {
    ...pair,
    ...computeChannelFrequencies(pair.carrierHz, pair.beatHz),
  };
}

export function addTonePair(
  pairs: TonePair[],
  input: TonePairInput = {},
  idFactory: () => string = createTonePairId,
): { pair: TonePair; pairs: TonePair[] } {
  const pair = sanitizeTonePair({
    ...input,
    id: input.id ?? idFactory(),
  });

  return {
    pair,
    pairs: [...pairs, pair],
  };
}

export function updateTonePair(
  pairs: TonePair[],
  id: string,
  input: Partial<Omit<TonePair, 'id'>>,
): TonePair[] {
  return pairs.map((pair) =>
    pair.id === id ? sanitizeTonePair({ ...pair, ...input }) : pair,
  );
}

export function removeTonePair(pairs: TonePair[], id: string): TonePair[] {
  if (pairs.length <= 1) {
    return pairs;
  }

  const nextPairs = pairs.filter((pair) => pair.id !== id);
  return nextPairs.length === 0 ? pairs : nextPairs;
}

function rampParam(
  context: AudioContext,
  param: AudioParam,
  value: number,
  rampSeconds = LIMITS.rampSeconds,
): void {
  const now = context.currentTime;
  const holdableParam = param as AudioParam & {
    cancelAndHoldAtTime?: (cancelTime: number) => AudioParam;
  };

  if (typeof holdableParam.cancelAndHoldAtTime === 'function') {
    holdableParam.cancelAndHoldAtTime(now);
  } else {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
  }

  param.linearRampToValueAtTime(value, now + rampSeconds);
}

function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = sampleRate * 2;
  const buffer = context.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }
  }

  return buffer;
}

interface ToneGraph {
  leftOsc: OscillatorNode;
  rightOsc: OscillatorNode;
  merger: ChannelMergerNode;
  output: GainNode;
}

interface NoiseGraph {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  stereo: StereoPannerNode;
  output: GainNode;
}

export class BinauralEngine {
  private context: AudioContext | null = null;

  private masterGainNode: GainNode | null = null;

  private noiseGraph: NoiseGraph | null = null;

  private pairGraphs = new Map<string, ToneGraph>();

  private removalTimeouts = new Map<string, number>();

  private suspendTimeoutId: number | null = null;

  private base: BaseParams = {
    pairs: [sanitizeTonePair()],
    masterGain: DEFAULT_MASTER_GAIN,
  };

  private noise = { ...DEFAULT_NOISE };

  private playbackState: PlaybackState = 'idle';

  getSnapshot(): EngineSnapshot {
    return {
      playbackState: this.playbackState,
      pairs: this.base.pairs.map(computeTonePairSnapshot),
      base: {
        masterGain: this.base.masterGain,
        pairs: this.base.pairs.map((pair) => ({ ...pair })),
      },
      noise: { ...this.noise },
    };
  }

  async start(): Promise<EngineSnapshot> {
    await this.ensureGraph();
    this.clearSuspendTimeout();

    if (!this.context) {
      throw new Error('Audio graph was not initialized.');
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    this.ensurePairGraphs();
    this.playbackState = 'running';
    this.syncMasterGain();
    this.syncNoise(LIMITS.transportFadeSeconds);
    this.base.pairs.forEach((pair) => {
      this.applyPairState(pair, LIMITS.transportFadeSeconds);
    });

    return this.getSnapshot();
  }

  async resume(): Promise<EngineSnapshot> {
    return this.start();
  }

  async stop(): Promise<EngineSnapshot> {
    if (!this.context) {
      this.playbackState = 'stopped';
      return this.getSnapshot();
    }

    this.playbackState = 'stopped';
    this.syncNoise(LIMITS.transportFadeSeconds);
    this.base.pairs.forEach((pair) => {
      this.applyPairState(pair, LIMITS.transportFadeSeconds);
    });

    this.clearSuspendTimeout();
    this.suspendTimeoutId = window.setTimeout(() => {
      this.teardownAllPairGraphs();

      if (this.context && this.context.state === 'running') {
        void this.context.suspend();
      }
    }, LIMITS.suspendDelayMs);

    return this.getSnapshot();
  }

  setBaseParams(params: Partial<BaseParams>): EngineSnapshot {
    const masterGain = clamp(
      params.masterGain ?? this.base.masterGain,
      LIMITS.gainMin,
      LIMITS.gainMax,
    );

    this.base = {
      masterGain,
      pairs: params.pairs?.map((pair) => sanitizeTonePair(pair)) ?? this.base.pairs,
    };

    this.syncMasterGain();
    this.syncPairGraphs();
    return this.getSnapshot();
  }

  setNoise(config: Partial<NoiseConfig>): EngineSnapshot {
    this.noise = sanitizeNoiseConfig({
      ...this.noise,
      ...config,
    });

    this.syncNoise();
    return this.getSnapshot();
  }

  addPair(input: TonePairInput = {}): string {
    const { pair, pairs } = addTonePair(this.base.pairs, input);
    this.base = {
      ...this.base,
      pairs,
    };

    if (this.playbackState === 'running') {
      this.ensurePairGraph(pair);
      this.applyPairState(pair, LIMITS.transportFadeSeconds);
    }

    return pair.id;
  }

  removePair(id: string): void {
    const existingPair = this.base.pairs.find((pair) => pair.id === id);
    const nextPairs = removeTonePair(this.base.pairs, id);

    if (!existingPair || nextPairs === this.base.pairs) {
      return;
    }

    this.base = {
      ...this.base,
      pairs: nextPairs,
    };

    if (this.playbackState === 'running') {
      this.fadeOutAndTeardownPair(id);
      return;
    }

    this.teardownPairGraph(id);
  }

  updatePair(id: string, params: Partial<Omit<TonePair, 'id'>>): void {
    this.base = {
      ...this.base,
      pairs: updateTonePair(this.base.pairs, id, params),
    };

    const pair = this.base.pairs.find((item) => item.id === id);
    if (!pair) {
      return;
    }

    if (this.playbackState === 'running') {
      this.ensurePairGraph(pair);
      this.applyPairState(pair, LIMITS.rampSeconds);
    }
  }

  private async ensureGraph(): Promise<void> {
    if (this.context) {
      return;
    }

    const context = new AudioContext();
    const masterGainNode = context.createGain();
    masterGainNode.gain.value = this.base.masterGain;
    masterGainNode.connect(context.destination);

    const noiseSource = context.createBufferSource();
    noiseSource.buffer = createNoiseBuffer(context);
    noiseSource.loop = true;

    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 420;
    noiseFilter.Q.value = 0.6;

    const noiseStereo = context.createStereoPanner();
    noiseStereo.pan.value = 0;

    const noiseOutput = context.createGain();
    noiseOutput.gain.value = LIMITS.noiseFloor;

    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseStereo);
    noiseStereo.connect(noiseOutput);
    noiseOutput.connect(masterGainNode);
    noiseSource.start();

    this.context = context;
    this.masterGainNode = masterGainNode;
    this.noiseGraph = {
      source: noiseSource,
      filter: noiseFilter,
      stereo: noiseStereo,
      output: noiseOutput,
    };
  }

  private syncMasterGain(): void {
    if (!this.context || !this.masterGainNode) {
      return;
    }

    rampParam(this.context, this.masterGainNode.gain, this.base.masterGain);
  }

  private syncNoise(rampSeconds = LIMITS.rampSeconds): void {
    if (!this.context || !this.noiseGraph) {
      return;
    }

    const targetGain =
      this.playbackState === 'running' && this.noise.enabled
        ? Math.max(this.noise.volume, LIMITS.noiseFloor)
        : LIMITS.noiseFloor;

    rampParam(this.context, this.noiseGraph.output.gain, targetGain, rampSeconds);
  }

  private ensurePairGraphs(): void {
    this.base.pairs.forEach((pair) => {
      this.ensurePairGraph(pair);
    });
  }

  private ensurePairGraph(pair: TonePair): ToneGraph {
    const existingGraph = this.pairGraphs.get(pair.id);
    if (existingGraph) {
      return existingGraph;
    }

    if (!this.context || !this.masterGainNode) {
      throw new Error('Audio graph was not initialized.');
    }

    const leftOsc = this.context.createOscillator();
    const rightOsc = this.context.createOscillator();
    const merger = this.context.createChannelMerger(2);
    const output = this.context.createGain();
    output.gain.value = 0;

    leftOsc.type = 'sine';
    rightOsc.type = 'sine';
    leftOsc.connect(merger, 0, 0);
    rightOsc.connect(merger, 0, 1);
    merger.connect(output);
    output.connect(this.masterGainNode);

    leftOsc.start();
    rightOsc.start();

    const graph: ToneGraph = {
      leftOsc,
      rightOsc,
      merger,
      output,
    };

    this.pairGraphs.set(pair.id, graph);
    this.clearRemovalTimeout(pair.id);
    return graph;
  }

  private syncPairGraphs(): void {
    const activeIds = new Set(this.base.pairs.map((pair) => pair.id));

    this.pairGraphs.forEach((_, id) => {
      if (!activeIds.has(id)) {
        this.teardownPairGraph(id);
      }
    });

    this.base.pairs.forEach((pair) => {
      if (this.playbackState === 'running') {
        this.ensurePairGraph(pair);
      }
      this.applyPairState(pair, LIMITS.rampSeconds);
    });
  }

  private applyPairState(pair: TonePair, gainRampSeconds: number): void {
    if (!this.context) {
      return;
    }

    const graph = this.pairGraphs.get(pair.id);
    if (!graph) {
      return;
    }

    const split = computeChannelFrequencies(pair.carrierHz, pair.beatHz);
    rampParam(this.context, graph.leftOsc.frequency, split.leftHz);
    rampParam(this.context, graph.rightOsc.frequency, split.rightHz);
    rampParam(
      this.context,
      graph.output.gain,
      this.playbackState === 'running' ? pair.gain : 0,
      gainRampSeconds,
    );
  }

  private fadeOutAndTeardownPair(id: string): void {
    if (!this.context) {
      this.teardownPairGraph(id);
      return;
    }

    const graph = this.pairGraphs.get(id);
    if (!graph) {
      return;
    }

    rampParam(this.context, graph.output.gain, 0, LIMITS.transportFadeSeconds);
    this.clearRemovalTimeout(id);
    const timeoutId = window.setTimeout(() => {
      this.teardownPairGraph(id);
    }, LIMITS.suspendDelayMs);

    this.removalTimeouts.set(id, timeoutId);
  }

  private teardownPairGraph(id: string): void {
    const graph = this.pairGraphs.get(id);
    if (!graph) {
      return;
    }

    this.clearRemovalTimeout(id);
    graph.leftOsc.stop();
    graph.rightOsc.stop();
    graph.leftOsc.disconnect();
    graph.rightOsc.disconnect();
    graph.merger.disconnect();
    graph.output.disconnect();
    this.pairGraphs.delete(id);
  }

  private teardownAllPairGraphs(): void {
    Array.from(this.pairGraphs.keys()).forEach((id) => {
      this.teardownPairGraph(id);
    });
  }

  private clearSuspendTimeout(): void {
    if (this.suspendTimeoutId !== null) {
      window.clearTimeout(this.suspendTimeoutId);
      this.suspendTimeoutId = null;
    }
  }

  private clearRemovalTimeout(id: string): void {
    const timeoutId = this.removalTimeouts.get(id);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      this.removalTimeouts.delete(id);
    }
  }
}
