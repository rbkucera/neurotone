import {
  BinauralEngine,
  type EngineSnapshot,
  type NoiseConfig,
  type TonePair,
  type TonePairSnapshot,
} from './audio/binauralEngine';
import {
  computeBeatMap,
  computeEnvelope,
  drawEnvelope,
} from './audio/visualization';

const UI_LIMITS = {
  carrierSliderMin: 80,
  carrierSliderMax: 500,
  carrierNumberMin: 20,
  carrierNumberMax: 1200,
  beatSliderMin: 1,
  beatSliderMax: 40,
  beatNumberMin: 0.1,
  beatNumberMax: 40,
};

function formatHz(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 2).replace(/\.00$/, '')} Hz`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function renderMetric(label: string, value: string): string {
  return `
    <div class="metric">
      <span class="metric__label">${label}</span>
      <strong class="metric__value">${value}</strong>
    </div>
  `;
}

function renderBeatEntryRow(
  label: string,
  frequencyHz: number,
  band: string,
  typeLabel?: string,
): string {
  return `
    <div class="beat-row">
      <div class="beat-row__copy">
        <span class="beat-row__label">${label}</span>
        ${typeLabel ? `<span class="beat-row__type">${typeLabel}</span>` : ''}
      </div>
      <div class="beat-row__meta">
        <strong>${formatHz(frequencyHz)}</strong>
        <span class="band-pill band-pill--${band}">${band}</span>
      </div>
    </div>
  `;
}

function renderPairCard(pair: TonePairSnapshot, canRemove: boolean): string {
  const lowCarrier = pair.carrierHz < UI_LIMITS.carrierSliderMin;

  return `
    <article class="layer-card" data-pair-card="${pair.id}">
      <div class="layer-card__header">
        <div>
          <p class="layer-card__eyebrow">Layer</p>
          <h3>Carrier ${formatHz(pair.carrierHz)}</h3>
        </div>
        <button
          class="ghost-button"
          data-action="remove-pair"
          data-pair-id="${pair.id}"
          ${canRemove ? '' : 'disabled'}
          aria-label="Remove layer"
        >
          Remove
        </button>
      </div>

      <div class="field-group">
        <label class="control">
          <div class="control__row">
            <span>Carrier frequency</span>
            <output data-role="carrier-output">${formatHz(pair.carrierHz)}</output>
          </div>
          <input
            data-input="carrierHz"
            data-pair-id="${pair.id}"
            type="range"
            min="${UI_LIMITS.carrierSliderMin}"
            max="${UI_LIMITS.carrierSliderMax}"
            step="1"
            value="${Math.min(
              UI_LIMITS.carrierSliderMax,
              Math.max(UI_LIMITS.carrierSliderMin, pair.carrierHz),
            )}"
          />
        </label>

        <label class="numeric-field">
          <span>Carrier value</span>
          <input
            data-input="carrierHz"
            data-pair-id="${pair.id}"
            type="number"
            min="${UI_LIMITS.carrierNumberMin}"
            max="${UI_LIMITS.carrierNumberMax}"
            step="1"
            value="${pair.carrierHz}"
          />
        </label>
      </div>

      <div class="field-group">
        <label class="control">
          <div class="control__row">
            <span>Beat frequency</span>
            <output data-role="beat-output">${formatHz(pair.beatHz)}</output>
          </div>
          <input
            data-input="beatHz"
            data-pair-id="${pair.id}"
            type="range"
            min="${UI_LIMITS.beatSliderMin}"
            max="${UI_LIMITS.beatSliderMax}"
            step="0.1"
            value="${Math.min(
              UI_LIMITS.beatSliderMax,
              Math.max(UI_LIMITS.beatSliderMin, pair.beatHz),
            )}"
          />
        </label>

        <label class="numeric-field">
          <span>Beat value</span>
          <input
            data-input="beatHz"
            data-pair-id="${pair.id}"
            type="number"
            min="${UI_LIMITS.beatNumberMin}"
            max="${UI_LIMITS.beatNumberMax}"
            step="0.1"
            value="${pair.beatHz}"
          />
        </label>
      </div>

      <label class="control">
        <div class="control__row">
          <span>Layer gain</span>
          <output data-role="gain-output">${formatPercent(pair.gain)}</output>
        </div>
        <input
          data-input="gain"
          data-pair-id="${pair.id}"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value="${pair.gain}"
        />
      </label>

      <div class="readout ${lowCarrier ? 'readout--muted' : ''}" data-role="pair-readout">
        <span data-role="left-readout">L ${formatHz(pair.leftHz)}</span>
        <span data-role="right-readout">R ${formatHz(pair.rightHz)}</span>
      </div>
    </article>
  `;
}

function renderNoiseControls(noise: NoiseConfig): string {
  return `
    <section class="noise-block">
      <div class="noise-block__header">
        <div>
          <p class="layer-card__eyebrow">Support Layer</p>
          <h3>Noise bed</h3>
        </div>
        <label class="toggle">
          <input data-input="noiseEnabled" type="checkbox" ${
            noise.enabled ? 'checked' : ''
          } />
          <span>Enabled</span>
        </label>
      </div>

      <label class="control">
        <div class="control__row">
          <span>Noise level</span>
          <output data-role="noise-output">${formatPercent(noise.volume)}</output>
        </div>
        <input
          data-input="noiseVolume"
          type="range"
          min="0"
          max="0.3"
          step="0.01"
          value="${noise.volume}"
        />
      </label>
    </section>
  `;
}

export function createApp(root: HTMLElement): void {
  const engine = new BinauralEngine();
  let state: EngineSnapshot = engine.getSnapshot();

  root.innerHTML = `
    <main class="shell">
      <section class="hero">
        <p class="eyebrow">Rycera Audio Lab</p>
        <h1>Binaural Beat Generator</h1>
        <p class="intro">
          Phase 1 now validates a multi-layer engine: independent tone pairs,
          stable transport, and click-free changes under live playback.
        </p>
        <div class="hero__actions">
          <button class="transport" data-action="toggle-play">Start session</button>
          <p class="notice">Headphones required. Multi-layer behavior is experimental.</p>
        </div>
      </section>

      <section class="panel panel--controls">
        <div class="panel__header">
          <h2>Layer Stack</h2>
          <span class="status" data-role="status-pill">Idle</span>
        </div>

        <div class="stack-note" data-role="stack-note"></div>
        <div class="layer-list" data-role="layer-list"></div>

        <button class="secondary-action" data-action="add-pair">Add layer</button>

        <section class="viz-panel">
          <div class="viz-panel__header">
            <div>
              <p class="layer-card__eyebrow">Diagnostic View</p>
              <h3>Beat map</h3>
            </div>
            <span class="subtle">Computed from layer state</span>
          </div>

          <div data-role="beat-map-primary"></div>
          <details class="viz-panel__details" data-role="beat-map-details">
            <summary>Second-order interactions</summary>
            <div data-role="beat-map-secondary"></div>
          </details>

          <div class="viz-panel__header viz-panel__header--envelope">
            <div>
              <p class="layer-card__eyebrow">Composite Motion</p>
              <h3>Envelope waveform</h3>
            </div>
            <span class="subtle">Pure math, no signal analysis</span>
          </div>

          <canvas
            class="envelope-canvas"
            data-role="envelope-canvas"
            height="96"
          ></canvas>
        </section>

        <div data-role="noise-controls"></div>
      </section>

      <section class="panel panel--metrics">
        <div class="panel__header">
          <h2>Validation Readout</h2>
          <span class="subtle">Live engine snapshot</span>
        </div>
        <div class="metrics" data-role="metrics"></div>
      </section>
    </main>
  `;

  const transportButton = root.querySelector<HTMLButtonElement>(
    '[data-action="toggle-play"]',
  );
  const statusPill = root.querySelector<HTMLElement>('[data-role="status-pill"]');
  const metrics = root.querySelector<HTMLElement>('[data-role="metrics"]');
  const layerList = root.querySelector<HTMLElement>('[data-role="layer-list"]');
  const stackNote = root.querySelector<HTMLElement>('[data-role="stack-note"]');
  const noiseControls = root.querySelector<HTMLElement>('[data-role="noise-controls"]');
  const beatMapPrimary = root.querySelector<HTMLElement>('[data-role="beat-map-primary"]');
  const beatMapSecondary = root.querySelector<HTMLElement>('[data-role="beat-map-secondary"]');
  const beatMapDetails = root.querySelector<HTMLDetailsElement>('[data-role="beat-map-details"]');
  const envelopeCanvas = root.querySelector<HTMLCanvasElement>('[data-role="envelope-canvas"]');
  let envelopeSamples = computeEnvelope([], 5, 0);
  let envelopeDurationSeconds = 5;
  let animationFrameId: number | null = null;

  const drawEnvelopeFrame = (timestampMs: number): void => {
    if (!envelopeCanvas) {
      return;
    }

    const playbackProgress =
      state.playbackState === 'running'
        ? ((timestampMs / 1000) % envelopeDurationSeconds) / envelopeDurationSeconds
        : 0;

    drawEnvelope(envelopeCanvas, envelopeSamples, playbackProgress);

    if (state.playbackState === 'running') {
      animationFrameId = window.requestAnimationFrame(drawEnvelopeFrame);
    } else {
      animationFrameId = null;
    }
  };

  const syncEnvelope = (): void => {
    if (!envelopeCanvas) {
      return;
    }

    const width = Math.max(320, Math.floor(envelopeCanvas.clientWidth || 560));
    const height = 96;

    if (envelopeCanvas.width !== width) {
      envelopeCanvas.width = width;
    }
    if (envelopeCanvas.height !== height) {
      envelopeCanvas.height = height;
    }

    envelopeSamples = computeEnvelope(state.pairs, envelopeDurationSeconds, width);

    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    drawEnvelope(envelopeCanvas, envelopeSamples, 0);

    if (state.playbackState === 'running') {
      animationFrameId = window.requestAnimationFrame(drawEnvelopeFrame);
    }
  };

  const syncBeatMap = (): void => {
    if (!beatMapPrimary || !beatMapSecondary || !beatMapDetails) {
      return;
    }

    const beatEntries = computeBeatMap(state.pairs);
    const primaryEntries = beatEntries.filter((entry) => entry.type !== 'second-order');
    const secondaryEntries = beatEntries.filter((entry) => entry.type === 'second-order');

    beatMapPrimary.innerHTML =
      primaryEntries.length > 0
        ? primaryEntries
            .map((entry) =>
              renderBeatEntryRow(
                entry.label,
                entry.frequencyHz,
                entry.band,
                entry.type === 'carrier-interference' ? 'emergent' : undefined,
              ),
            )
            .join('')
        : '<p class="subtle">No active beats yet.</p>';

    beatMapSecondary.innerHTML =
      secondaryEntries.length > 0
        ? secondaryEntries
            .map((entry) =>
              renderBeatEntryRow(entry.label, entry.frequencyHz, entry.band),
            )
            .join('')
        : '<p class="subtle">No second-order interactions.</p>';

    if (secondaryEntries.length === 0) {
      beatMapDetails.open = false;
    }
  };

  const syncPairCard = (pair: TonePairSnapshot): void => {
    const card = layerList?.querySelector<HTMLElement>(`[data-pair-card="${pair.id}"]`);
    if (!card) {
      return;
    }

    const title = card.querySelector<HTMLHeadingElement>('h3');
    if (title) {
      title.textContent = `Carrier ${formatHz(pair.carrierHz)}`;
    }

    const carrierOutput = card.querySelector<HTMLOutputElement>('[data-role="carrier-output"]');
    const beatOutput = card.querySelector<HTMLOutputElement>('[data-role="beat-output"]');
    const gainOutput = card.querySelector<HTMLOutputElement>('[data-role="gain-output"]');
    const leftReadout = card.querySelector<HTMLElement>('[data-role="left-readout"]');
    const rightReadout = card.querySelector<HTMLElement>('[data-role="right-readout"]');
    const readout = card.querySelector<HTMLElement>('[data-role="pair-readout"]');
    const carrierRange = card.querySelector<HTMLInputElement>(
      'input[type="range"][data-input="carrierHz"]',
    );
    const carrierNumber = card.querySelector<HTMLInputElement>(
      'input[type="number"][data-input="carrierHz"]',
    );
    const beatRange = card.querySelector<HTMLInputElement>(
      'input[type="range"][data-input="beatHz"]',
    );
    const beatNumber = card.querySelector<HTMLInputElement>(
      'input[type="number"][data-input="beatHz"]',
    );
    const gainRange = card.querySelector<HTMLInputElement>(
      'input[type="range"][data-input="gain"]',
    );

    if (carrierOutput) {
      carrierOutput.value = formatHz(pair.carrierHz);
    }
    if (beatOutput) {
      beatOutput.value = formatHz(pair.beatHz);
    }
    if (gainOutput) {
      gainOutput.value = formatPercent(pair.gain);
    }
    if (leftReadout) {
      leftReadout.textContent = `L ${formatHz(pair.leftHz)}`;
    }
    if (rightReadout) {
      rightReadout.textContent = `R ${formatHz(pair.rightHz)}`;
    }
    if (readout) {
      readout.classList.toggle('readout--muted', pair.carrierHz < UI_LIMITS.carrierSliderMin);
    }
    if (carrierRange) {
      carrierRange.value = String(
        Math.min(
          UI_LIMITS.carrierSliderMax,
          Math.max(UI_LIMITS.carrierSliderMin, pair.carrierHz),
        ),
      );
    }
    if (carrierNumber) {
      carrierNumber.value = String(pair.carrierHz);
    }
    if (beatRange) {
      beatRange.value = String(
        Math.min(UI_LIMITS.beatSliderMax, Math.max(UI_LIMITS.beatSliderMin, pair.beatHz)),
      );
    }
    if (beatNumber) {
      beatNumber.value = String(pair.beatHz);
    }
    if (gainRange) {
      gainRange.value = String(pair.gain);
    }
  };

  const syncNoiseCard = (): void => {
    const noiseCheckbox = noiseControls?.querySelector<HTMLInputElement>(
      'input[type="checkbox"][data-input="noiseEnabled"]',
    );
    const noiseRange = noiseControls?.querySelector<HTMLInputElement>(
      'input[type="range"][data-input="noiseVolume"]',
    );
    const noiseOutput = noiseControls?.querySelector<HTMLOutputElement>('[data-role="noise-output"]');

    if (noiseCheckbox) {
      noiseCheckbox.checked = state.noise.enabled;
    }
    if (noiseRange) {
      noiseRange.value = String(state.noise.volume);
    }
    if (noiseOutput) {
      noiseOutput.value = formatPercent(state.noise.volume);
    }
  };

  const syncView = ({
    renderLayers = false,
    renderNoise = false,
  }: {
    renderLayers?: boolean;
    renderNoise?: boolean;
  } = {}): void => {
    if (
      !transportButton ||
      !statusPill ||
      !metrics ||
      !layerList ||
      !stackNote ||
      !noiseControls ||
      !beatMapPrimary ||
      !beatMapSecondary ||
      !beatMapDetails
    ) {
      return;
    }

    transportButton.textContent =
      state.playbackState === 'running' ? 'Stop session' : 'Start session';
    statusPill.textContent =
      state.playbackState === 'running' ? 'Running' : 'Idle';
    statusPill.dataset.state = state.playbackState;

    if (renderLayers) {
      layerList.innerHTML = state.pairs
        .map((pair) => renderPairCard(pair, state.pairs.length > 1))
        .join('');
    }
    state.pairs.forEach(syncPairCard);

    stackNote.innerHTML =
      state.pairs.length > 1
        ? `
          <p class="stack-note__text">
            Multiple layers share the master volume. Reduce individual layer gains to avoid clipping.
          </p>
        `
        : '';

    if (renderNoise) {
      noiseControls.innerHTML = renderNoiseControls(state.noise);
    }
    syncNoiseCard();
    syncBeatMap();
    syncEnvelope();

    const totalLayerGain = state.pairs.reduce((sum, pair) => sum + pair.gain, 0);
    metrics.innerHTML = [
      renderMetric('Active layers', String(state.pairs.length)),
      renderMetric('Master mix', formatPercent(state.base.masterGain)),
      renderMetric('Noise bed', state.noise.enabled ? formatPercent(state.noise.volume) : 'Off'),
      renderMetric('Layer sum', formatPercent(totalLayerGain)),
    ].join('');
  };

  const refresh = (options?: { renderLayers?: boolean; renderNoise?: boolean }): void => {
    state = engine.getSnapshot();
    syncView(options);
  };

  const updatePairField = (pairId: string, key: keyof TonePair, value: number): void => {
    engine.updatePair(pairId, { [key]: value } as Partial<Omit<TonePair, 'id'>>);
    refresh();
  };

  const handleInput = (target: HTMLInputElement): void => {
    const pairId = target.dataset.pairId;
    const key = target.dataset.input;

    if (!key) {
      return;
    }

    if (key === 'noiseEnabled') {
      engine.setNoise({ enabled: target.checked });
      refresh();
      return;
    }

    if (key === 'noiseVolume') {
      engine.setNoise({ volume: Number(target.value) });
      refresh();
      return;
    }

    if (!pairId || target.value === '') {
      return;
    }

    const numericValue = Number(target.value);

    if (key === 'carrierHz' || key === 'beatHz' || key === 'gain') {
      updatePairField(pairId, key, numericValue);
    }
  };

  root.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    if (target.type === 'number') {
      return;
    }

    handleInput(target);
  });

  root.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    handleInput(target);
  });

  root.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionTarget = target.closest<HTMLElement>('[data-action]');
    if (!actionTarget) {
      return;
    }

    const action = actionTarget.dataset.action;
    if (!action) {
      return;
    }

    if (action === 'toggle-play') {
      state =
        state.playbackState === 'running'
          ? await engine.stop()
          : await engine.start();
      syncView();
      return;
    }

    if (action === 'add-pair') {
      engine.addPair({
        carrierHz: 200,
        beatHz: 10,
        gain: 0.8,
      });
      refresh({ renderLayers: true });
      return;
    }

    if (action === 'remove-pair' && actionTarget.dataset.pairId) {
      engine.removePair(actionTarget.dataset.pairId);
      refresh({ renderLayers: true });
    }
  });

  window.addEventListener('resize', () => {
    syncEnvelope();
  });

  syncView({ renderLayers: true, renderNoise: true });
}
