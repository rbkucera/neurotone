import {
  BinauralEngine,
  addTonePair,
  computeTonePairSnapshot,
  removeTonePair,
  updateTonePair,
  type EngineSnapshot,
  type NoiseConfig,
  type NoiseModel,
  type TonePair,
  type TonePairSnapshot,
} from './audio/binauralEngine';
import {
  computeBeatMap,
  computeEnvelope,
  drawEnvelope,
} from './audio/visualization';
import { generateSessionPlan } from './composer/generator';
import { getPresetById, presets } from './presets';
import {
  clampMidiToCarrierRange,
  frequencyToNearestMidi,
  frequencyToNoteLabel,
  midiToFrequency,
  parseNoteLabel,
  type CarrierDisplayMode,
} from './noteUtils';
import { SessionSequencer } from './sequencer/SessionSequencer';
import type {
  AutomationLane,
  AutomationTarget,
  CompositionRequest,
  SegmentOverrideLane,
  SegmentOverrideTarget,
  SessionDefinition,
  SessionPlaybackState,
  SessionSegment,
  SessionSoundState,
} from './sequencer/types';
import {
  buildSegmentWindows,
  createSessionDefinition,
  createSessionSegment,
  sanitizeSessionSoundState,
  totalSessionDuration,
  type SegmentWindow,
} from './sequencer/utils';
import {
  composerDraftToRequest,
  createInitialShareableState,
  decodeShareableState,
  encodeShareableState,
  hasSeenHeadphoneNotice,
  loadStoredState,
  markHeadphoneNoticeSeen,
  saveStoredState,
  type ComposerDraft,
  type PlaybackMode,
  type ShareableState,
} from './sessionState';
import {
  hasExistingTimeline,
  loadTimelineWorkspaceUIState,
  normalizeTimelineWorkspaceUIState,
  saveTimelineWorkspaceUIState,
  type AnalysisDockTab,
  type TimelineInspectorTab,
  type TimelineWorkspaceTab,
  type TimelineWorkspaceUIState,
} from './timelineWorkspace';

const UI_LIMITS = {
  carrierSliderMin: 40,
  carrierSliderMax: 1200,
  carrierNumberMin: 20,
  carrierNumberMax: 1200,
  beatSliderMin: 1,
  beatSliderMax: 40,
  beatNumberMin: 0.1,
  beatNumberMax: 40,
};

const TIMELINE_RAIL_LAYOUT = {
  gapPx: 14,
  minWidthPx: 176,
  maxWidthPx: 2400,
  minProgressWidthPx: 120,
  baseSecondsWidthPx: 28,
  innerPaddingPx: 18,
  rulerHeightPx: 34,
  rulerMajorTickPx: 14,
};

const TIMELINE_ZOOM = {
  min: 0.1,
  max: 3,
  step: 0.1,
  default: 1,
};

const ADVANCED_LAYOUT = {
  labelWidthPx: 118,
  rulerHeightPx: 32,
  segmentStripHeightPx: 42,
  laneRowHeightPx: 42,
  laneGapPx: 10,
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatHz(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 2).replace(/\.00$/, '')} Hz`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '')} s`;
}

function formatCarrierDisplay(
  carrierHz: number,
  carrierDisplayMode: CarrierDisplayMode,
): string {
  return carrierDisplayMode === 'note'
    ? frequencyToNoteLabel(carrierHz)
    : formatHz(carrierHz);
}

function renderMetric(label: string, value: string): string {
  return `
    <div class="metric">
      <span class="metric__label">${label}</span>
      <strong class="metric__value">${escapeHtml(value)}</strong>
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
        <span class="beat-row__label">${escapeHtml(label)}</span>
        ${typeLabel ? `<span class="beat-row__type">${escapeHtml(typeLabel)}</span>` : ''}
      </div>
      <div class="beat-row__meta">
        <strong>${formatHz(frequencyHz)}</strong>
        <span class="band-pill band-pill--${band}">${band}</span>
      </div>
    </div>
  `;
}

function renderNoiseModelOptions(currentModel: NoiseModel): string {
  const models: Array<{ value: NoiseModel; label: string }> = [
    { value: 'soft', label: 'Soft filtered' },
    { value: 'white', label: 'White noise' },
    { value: 'pink', label: 'Pink noise' },
    { value: 'brown', label: 'Brown noise' },
    { value: 'surf', label: 'Surf wash' },
  ];

  return models
    .map(
      (model) => `
        <option value="${model.value}" ${
          currentModel === model.value ? 'selected' : ''
        }>
          ${model.label}
        </option>
      `,
    )
    .join('');
}

function renderPresetOptions(currentPresetId: string | null): string {
  return [
    '<option value="custom">Custom session</option>',
    ...presets.map(
      (preset) => `
        <option value="${preset.id}" ${
          currentPresetId === preset.id ? 'selected' : ''
        }>
          ${preset.label}
        </option>
      `,
    ),
  ].join('');
}

function renderCarrierModeToggle(currentMode: CarrierDisplayMode): string {
  return `
    <div class="segmented-control">
      <button
        class="segmented-control__button ${currentMode === 'hz' ? 'is-active' : ''}"
        data-action="set-carrier-mode"
        data-mode="hz"
        type="button"
      >
        Hz
      </button>
      <button
        class="segmented-control__button ${currentMode === 'note' ? 'is-active' : ''}"
        data-action="set-carrier-mode"
        data-mode="note"
        type="button"
      >
        Notes
      </button>
    </div>
  `;
}

function renderPlaybackModeToggle(currentMode: PlaybackMode): string {
  return `
    <div class="segmented-control">
      <button
        class="segmented-control__button ${currentMode === 'manual' ? 'is-active' : ''}"
        data-action="set-playback-mode"
        data-mode="manual"
        type="button"
      >
        Manual
      </button>
      <button
        class="segmented-control__button ${currentMode === 'timeline' ? 'is-active' : ''}"
        data-action="set-playback-mode"
        data-mode="timeline"
        type="button"
      >
        Timeline
      </button>
    </div>
  `;
}

function renderInspectorTabToggle(currentTab: TimelineInspectorTab): string {
  return `
    <div class="segmented-control segmented-control--compact">
      <button
        class="segmented-control__button ${currentTab === 'segment' ? 'is-active' : ''}"
        data-action="set-inspector-tab"
        data-tab="segment"
        type="button"
      >
        Segment
      </button>
      <button
        class="segmented-control__button ${currentTab === 'layers' ? 'is-active' : ''}"
        data-action="set-inspector-tab"
        data-tab="layers"
        type="button"
      >
        Layers
      </button>
      <button
        class="segmented-control__button ${currentTab === 'support' ? 'is-active' : ''}"
        data-action="set-inspector-tab"
        data-tab="support"
        type="button"
      >
        Support
      </button>
    </div>
  `;
}

function renderSegmentMetaControls(segment: SessionSegment): string {
  const holdDuration = Math.max(1, segment.holdDuration);
  const transitionDuration = Math.min(
    holdDuration,
    Math.max(0, segment.transitionDuration),
  );

  return `
    <div class="segment-compact">
      <label class="numeric-field segment-compact__label">
        <span>Segment label</span>
        <input data-input="segment-label" type="text" value="${escapeHtml(segment.label || '')}" />
      </label>

      <div class="segment-slider-row">
        <label class="control segment-slider-row__control">
          <div class="control__row">
            <span>Hold duration</span>
            <output data-role="segment-hold-output">${formatSeconds(holdDuration)}</output>
          </div>
          <input
            data-input="segment-hold-slider"
            type="range"
            min="1"
            max="60"
            step="0.5"
            value="${holdDuration}"
          />
        </label>

        <label class="numeric-field segment-slider-row__numeric">
          <span>Hold</span>
          <input
            data-input="segment-hold-duration"
            type="number"
            min="1"
            max="60"
            step="0.5"
            value="${holdDuration}"
          />
        </label>
      </div>

      <label class="control">
        <div class="control__row">
          <span>Transition duration</span>
          <output data-role="segment-transition-output">${formatSeconds(
            transitionDuration,
          )}</output>
        </div>
        <input
          data-input="segment-transition-slider"
          type="range"
          min="0"
          max="${holdDuration}"
          step="0.5"
          value="${transitionDuration}"
        />
      </label>
    </div>
  `;
}

function clampSegmentHold(value: number): number {
  return Math.min(60, Math.max(1, value));
}

function clampSegmentTransition(value: number, holdDuration: number): number {
  return Math.min(clampSegmentHold(holdDuration), Math.max(0, value));
}

function renderLayerMixerRow(
  pair: TonePairSnapshot,
  selected: boolean,
  carrierDisplayMode: CarrierDisplayMode,
  canRemove: boolean,
): string {
  return `
    <article class="mixer-row ${selected ? 'is-selected' : ''}" data-pair-row="${pair.id}">
      <button
        class="mixer-row__button"
        data-action="select-pair"
        data-pair-id="${pair.id}"
        type="button"
      >
        <span class="mixer-row__label">${escapeHtml(
          formatCarrierDisplay(pair.carrierHz, carrierDisplayMode),
        )}</span>
        <span class="mixer-row__value" data-role="row-beat">${formatHz(pair.beatHz)}</span>
        <span class="mixer-row__value" data-role="row-gain">${formatPercent(pair.gain)}</span>
      </button>
      <button
        class="ghost-button ghost-button--compact"
        data-action="remove-pair"
        data-pair-id="${pair.id}"
        type="button"
        ${canRemove ? '' : 'disabled'}
      >
        Remove
      </button>
    </article>
  `;
}

function renderLayerMiniMixer(
  pair: TonePairSnapshot,
  carrierDisplayMode: CarrierDisplayMode,
): string {
  const carrierDisplay = formatCarrierDisplay(pair.carrierHz, carrierDisplayMode);
  const carrierSliderValue =
    carrierDisplayMode === 'note'
      ? String(clampMidiToCarrierRange(frequencyToNearestMidi(pair.carrierHz)))
      : String(
          Math.min(
            UI_LIMITS.carrierSliderMax,
            Math.max(UI_LIMITS.carrierSliderMin, pair.carrierHz),
          ),
        );
  const carrierSliderMin =
    carrierDisplayMode === 'note'
      ? String(
          clampMidiToCarrierRange(
            frequencyToNearestMidi(UI_LIMITS.carrierSliderMin),
          ),
        )
      : String(UI_LIMITS.carrierSliderMin);
  const carrierSliderMax =
    carrierDisplayMode === 'note'
      ? String(
          clampMidiToCarrierRange(
            frequencyToNearestMidi(UI_LIMITS.carrierSliderMax),
          ),
        )
      : String(UI_LIMITS.carrierSliderMax);
  const carrierInput =
    carrierDisplayMode === 'note'
      ? `
        <input
          data-input="carrierNote"
          data-pair-id="${pair.id}"
          data-role="carrier-editor"
          type="text"
          value="${escapeHtml(carrierDisplay)}"
          spellcheck="false"
          autocapitalize="characters"
        />
      `
      : `
        <input
          data-input="carrierHz"
          data-pair-id="${pair.id}"
          data-role="carrier-editor"
          type="number"
          min="${UI_LIMITS.carrierNumberMin}"
          max="${UI_LIMITS.carrierNumberMax}"
          step="1"
          value="${pair.carrierHz}"
        />
      `;

  return `
    <div class="mini-mixer" data-role="layer-editor" data-pair-id="${pair.id}">
      <div class="mini-mixer__header">
        <strong data-role="mini-title">Carrier ${escapeHtml(carrierDisplay)}</strong>
        <span class="readout readout--compact" data-role="pair-readout">
          <span data-role="left-readout">L ${formatHz(pair.leftHz)}</span>
          <span data-role="right-readout">R ${formatHz(pair.rightHz)}</span>
        </span>
      </div>

      <label class="panel__tool inspector-section__tool">
        <span class="subtle">Carrier display</span>
        ${renderCarrierModeToggle(carrierDisplayMode)}
      </label>

      <div class="mini-mixer__row">
        <label class="control mini-mixer__slider">
          <div class="control__row">
            <span>Carrier</span>
            <output data-role="carrier-output">${escapeHtml(carrierDisplay)}</output>
          </div>
          <input
            data-input="carrierHz"
            data-pair-id="${pair.id}"
            type="range"
            min="${carrierSliderMin}"
            max="${carrierSliderMax}"
            step="1"
            value="${carrierSliderValue}"
          />
        </label>
        <label class="numeric-field mini-mixer__field">
          <span>${carrierDisplayMode === 'note' ? 'Note' : 'Hz'}</span>
          ${carrierInput}
          <span class="field-hint" data-role="carrier-hint">${formatHz(pair.carrierHz)}</span>
        </label>
      </div>

      <div class="mini-mixer__row">
        <label class="control mini-mixer__slider">
          <div class="control__row">
            <span>Beat</span>
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
        <label class="numeric-field mini-mixer__field">
          <span>Beat</span>
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

      <div class="mini-mixer__row">
        <label class="control mini-mixer__slider">
          <div class="control__row">
            <span>Gain</span>
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
        <label class="numeric-field mini-mixer__field">
          <span>Gain</span>
          <input
            data-input="gain"
            data-pair-id="${pair.id}"
            type="number"
            min="0"
            max="1"
            step="0.01"
            value="${pair.gain}"
          />
        </label>
      </div>
    </div>
  `;
}

function renderAnalysisDockTabToggle(currentTab: AnalysisDockTab): string {
  return `
    <div class="segmented-control segmented-control--compact">
      <button
        class="segmented-control__button ${currentTab === 'envelope' ? 'is-active' : ''}"
        data-action="set-analysis-dock-tab"
        data-tab="envelope"
        type="button"
      >
        Envelope
      </button>
      <button
        class="segmented-control__button ${currentTab === 'beat-map' ? 'is-active' : ''}"
        data-action="set-analysis-dock-tab"
        data-tab="beat-map"
        type="button"
      >
        Beat Map
      </button>
      <button
        class="segmented-control__button ${currentTab === 'metrics' ? 'is-active' : ''}"
        data-action="set-analysis-dock-tab"
        data-tab="metrics"
        type="button"
      >
        Metrics
      </button>
    </div>
  `;
}

function renderPairCard(
  pair: TonePairSnapshot,
  canRemove: boolean,
  carrierDisplayMode: CarrierDisplayMode,
): string {
  const lowCarrier = pair.carrierHz < UI_LIMITS.carrierSliderMin;
  const carrierDisplay = formatCarrierDisplay(pair.carrierHz, carrierDisplayMode);
  const carrierSliderValue =
    carrierDisplayMode === 'note'
      ? String(clampMidiToCarrierRange(frequencyToNearestMidi(pair.carrierHz)))
      : String(
          Math.min(
            UI_LIMITS.carrierSliderMax,
            Math.max(UI_LIMITS.carrierSliderMin, pair.carrierHz),
          ),
        );
  const carrierSliderMin =
    carrierDisplayMode === 'note'
      ? String(
          clampMidiToCarrierRange(
            frequencyToNearestMidi(UI_LIMITS.carrierSliderMin),
          ),
        )
      : String(UI_LIMITS.carrierSliderMin);
  const carrierSliderMax =
    carrierDisplayMode === 'note'
      ? String(
          clampMidiToCarrierRange(
            frequencyToNearestMidi(UI_LIMITS.carrierSliderMax),
          ),
        )
      : String(UI_LIMITS.carrierSliderMax);
  const carrierInput =
    carrierDisplayMode === 'note'
      ? `
        <input
          data-input="carrierNote"
          data-pair-id="${pair.id}"
          data-role="carrier-editor"
          type="text"
          value="${escapeHtml(carrierDisplay)}"
          spellcheck="false"
          autocapitalize="characters"
        />
      `
      : `
        <input
          data-input="carrierHz"
          data-pair-id="${pair.id}"
          data-role="carrier-editor"
          type="number"
          min="${UI_LIMITS.carrierNumberMin}"
          max="${UI_LIMITS.carrierNumberMax}"
          step="1"
          value="${pair.carrierHz}"
        />
      `;

  return `
    <article class="layer-card" data-pair-card="${pair.id}">
      <div class="layer-card__header">
        <div>
          <p class="layer-card__eyebrow">Layer</p>
          <h3>Carrier ${escapeHtml(carrierDisplay)}</h3>
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
            <output data-role="carrier-output">${escapeHtml(carrierDisplay)}</output>
          </div>
          <input
            data-input="carrierHz"
            data-pair-id="${pair.id}"
            type="range"
            min="${carrierSliderMin}"
            max="${carrierSliderMax}"
            step="1"
            value="${carrierSliderValue}"
          />
        </label>

        <label class="numeric-field">
          <span>${carrierDisplayMode === 'note' ? 'Carrier note' : 'Carrier value'}</span>
          ${carrierInput}
          <span class="field-hint" data-role="carrier-hint">${formatHz(pair.carrierHz)}</span>
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

function renderSupportControls(noise: NoiseConfig, masterGain: number): string {
  return `
    <section class="support-compact">
      <label class="toggle support-compact__toggle">
        <input data-input="noiseEnabled" type="checkbox" ${
          noise.enabled ? 'checked' : ''
        } />
        <span>Noise bed</span>
      </label>

      <label class="select-field">
        <span>Noise model</span>
        <select data-input="noiseModel">
          ${renderNoiseModelOptions(noise.model)}
        </select>
      </label>

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

      <label class="control">
        <div class="control__row">
          <span>Master volume</span>
          <output data-role="master-output">${formatPercent(masterGain)}</output>
        </div>
        <input
          data-input="masterGain"
          type="range"
          min="0"
          max="0.45"
          step="0.01"
          value="${masterGain}"
        />
      </label>
    </section>
  `;
}

function describeAutomationTarget(target: AutomationTarget): string {
  if (target === 'masterGain') {
    return 'Master volume';
  }
  if (target === 'noise.volume') {
    return 'Noise level';
  }
  if (target === 'noise.enabled') {
    return 'Noise enabled';
  }
  if (target === 'noise.model') {
    return 'Noise model';
  }

  const pairMatch = target.match(/^pair:(.+)\.(carrierHz|beatHz|gain)$/);
  if (!pairMatch) {
    return target;
  }

  const [, pairId, field] = pairMatch;
  const fieldLabel =
    field === 'carrierHz'
      ? 'Carrier'
      : field === 'beatHz'
        ? 'Beat'
        : 'Gain';
  return `${fieldLabel} (${pairId})`;
}

function collectAutomationTargets(session: SessionDefinition): AutomationTarget[] {
  const pairIds = new Set<string>();
  session.segments.forEach((segment) => {
    segment.state.pairs.forEach((pair) => pairIds.add(pair.id));
  });

  return [
    'masterGain',
    'noise.volume',
    'noise.enabled',
    'noise.model',
    ...Array.from(pairIds).flatMap((pairId) => [
      `pair:${pairId}.carrierHz` as const,
      `pair:${pairId}.beatHz` as const,
      `pair:${pairId}.gain` as const,
    ]),
  ];
}

function renderAutomationTargetOptions(
  currentTarget: AutomationTarget,
  targets: AutomationTarget[],
): string {
  return targets
    .map(
      (target) => `
        <option value="${target}" ${currentTarget === target ? 'selected' : ''}>
          ${escapeHtml(describeAutomationTarget(target))}
        </option>
      `,
    )
    .join('');
}

type OverrideValueControl =
  | {
      kind: 'numeric';
      min: number;
      max: number;
      step: number;
    }
  | {
      kind: 'boolean';
    }
  | {
      kind: 'enum';
    };

function clampNumeric(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function overrideValueControl(target: AutomationTarget): OverrideValueControl {
  if (target === 'noise.enabled') {
    return { kind: 'boolean' };
  }

  if (target === 'noise.model') {
    return { kind: 'enum' };
  }

  if (target === 'masterGain') {
    return { kind: 'numeric', min: 0, max: 0.45, step: 0.01 };
  }

  if (target === 'noise.volume') {
    return { kind: 'numeric', min: 0, max: 0.3, step: 0.01 };
  }

  if (target.endsWith('.gain')) {
    return { kind: 'numeric', min: 0, max: 1, step: 0.01 };
  }

  if (target.endsWith('.beatHz')) {
    return { kind: 'numeric', min: 1, max: 40, step: 0.1 };
  }

  return { kind: 'numeric', min: 40, max: 1200, step: 1 };
}

function isDiscreteOverrideTarget(target: AutomationTarget): boolean {
  const control = overrideValueControl(target);
  return control.kind === 'boolean' || control.kind === 'enum';
}

function effectiveOverrideInterpolation(
  target: AutomationTarget,
  interpolation: 'linear' | 'step',
): 'linear' | 'step' {
  return isDiscreteOverrideTarget(target)
    ? 'step'
    : interpolation === 'step'
      ? 'step'
      : 'linear';
}

function normalizeKeyframeValue(
  target: AutomationTarget,
  rawValue: number | boolean | string,
): number | boolean | NoiseModel {
  const control = overrideValueControl(target);

  if (control.kind === 'boolean') {
    return rawValue === true || rawValue === 'true';
  }

  if (control.kind === 'enum') {
    const model = typeof rawValue === 'string' ? rawValue : 'soft';
    if (
      model === 'soft' ||
      model === 'white' ||
      model === 'pink' ||
      model === 'brown' ||
      model === 'surf'
    ) {
      return model;
    }

    return 'soft';
  }

  const numericValue =
    typeof rawValue === 'number' ? rawValue : Number(rawValue);
  const normalized = Number.isFinite(numericValue) ? numericValue : control.min;
  return clampNumeric(normalized, control.min, control.max);
}

function renderKeyframeValueInput(
  lane: AutomationLane,
  keyframeId: string,
  value: number | boolean | NoiseModel,
): string {
  if (lane.target === 'noise.enabled') {
    return `
      <select data-input="lane-value" data-lane-id="${lane.id}" data-keyframe-id="${keyframeId}">
        <option value="true" ${value === true ? 'selected' : ''}>On</option>
        <option value="false" ${value === false ? 'selected' : ''}>Off</option>
      </select>
    `;
  }

  if (lane.target === 'noise.model') {
    return `
      <select data-input="lane-value" data-lane-id="${lane.id}" data-keyframe-id="${keyframeId}">
        ${renderNoiseModelOptions(value as NoiseModel)}
      </select>
    `;
  }

  const step =
    lane.target === 'masterGain' || lane.target === 'noise.volume'
      ? '0.01'
      : lane.target.endsWith('.gain')
        ? '0.01'
        : lane.target.endsWith('.beatHz')
          ? '0.1'
          : '1';

  return `
    <input
      data-input="lane-value"
      data-lane-id="${lane.id}"
      data-keyframe-id="${keyframeId}"
      type="number"
      step="${step}"
      value="${value}"
    />
  `;
}

function renderLaneCards(session: SessionDefinition): string {
  const customLanes = session.automationLanes.filter(
    (lane) => lane.source === 'custom',
  );
  const targets = collectAutomationTargets(session);

  if (customLanes.length === 0) {
    return '<p class="subtle">No custom automation overrides yet. Segment-derived automation stays implicit until you open it up with a custom lane.</p>';
  }

  return customLanes
    .map(
      (lane) => `
        <article class="lane-card" data-lane-card="${lane.id}">
          <div class="lane-card__header">
            <strong>${escapeHtml(lane.label)}</strong>
            <button class="ghost-button" data-action="remove-lane" data-lane-id="${lane.id}" type="button">Remove lane</button>
          </div>

          <div class="lane-grid">
            <label class="select-field">
              <span>Target</span>
              <select data-input="lane-target" data-lane-id="${lane.id}">
                ${renderAutomationTargetOptions(lane.target, targets)}
              </select>
            </label>

            <label class="select-field">
              <span>Interpolation</span>
              <select data-input="lane-interpolation" data-lane-id="${lane.id}">
                <option value="linear" ${lane.interpolation === 'linear' ? 'selected' : ''}>Linear</option>
                <option value="step" ${lane.interpolation === 'step' ? 'selected' : ''}>Step</option>
              </select>
            </label>

            <label class="toggle">
              <input data-input="lane-enabled" data-lane-id="${lane.id}" type="checkbox" ${lane.enabled ? 'checked' : ''} />
              <span>Lane enabled</span>
            </label>
          </div>

          <div class="keyframe-list">
            ${lane.keyframes
              .map(
                (keyframe) => `
                  <div class="keyframe-row">
                    <label class="numeric-field">
                      <span>Time</span>
                      <input
                        data-input="lane-time"
                        data-lane-id="${lane.id}"
                        data-keyframe-id="${keyframe.id}"
                        type="number"
                        step="0.1"
                        min="0"
                        value="${keyframe.time}"
                      />
                    </label>

                    <label class="numeric-field">
                      <span>Value</span>
                      ${renderKeyframeValueInput(lane, keyframe.id, keyframe.value as number | boolean | NoiseModel)}
                    </label>

                    <button class="ghost-button" data-action="remove-keyframe" data-lane-id="${lane.id}" data-keyframe-id="${keyframe.id}" type="button">Remove</button>
                  </div>
                `,
              )
              .join('')}
          </div>

          <button class="secondary-action secondary-action--compact" data-action="add-keyframe" data-lane-id="${lane.id}" type="button">
            Add keyframe
          </button>
        </article>
      `,
    )
    .join('');
}

function shortAutomationTargetLabel(target: AutomationTarget): string {
  if (target === 'masterGain') {
    return 'Master';
  }
  if (target === 'noise.volume') {
    return 'Noise';
  }
  if (target === 'noise.enabled') {
    return 'Gate';
  }
  if (target === 'noise.model') {
    return 'Model';
  }

  const pairMatch = target.match(/^pair:(.+)\.(carrierHz|beatHz|gain)$/);
  if (!pairMatch) {
    return target;
  }

  const [, pairId, field] = pairMatch;
  const fieldLabel =
    field === 'carrierHz'
      ? 'Carrier'
      : field === 'beatHz'
        ? 'Beat'
        : 'Gain';
  return `${fieldLabel} ${pairId.slice(-3)}`;
}

function segmentSpanDuration(window: SegmentWindow): number {
  return Math.max(window.end - window.transitionStart, 0.0001);
}

interface TimelineClipModel {
  window: SegmentWindow;
  left: number;
  width: number;
}

interface TimelineViewportTick {
  time: number;
  left: number;
  label: string;
}

interface TimelineViewportModel {
  zoom: number;
  pixelsPerSecond: number;
  clips: TimelineClipModel[];
  rulerTicks: TimelineViewportTick[];
  contentWidth: number;
  globalPlayheadX: number;
  totalDuration: number;
}

function pixelsPerSecond(zoomLevel: number): number {
  return TIMELINE_RAIL_LAYOUT.baseSecondsWidthPx * zoomLevel;
}

function timelineTickStep(totalDuration: number, zoomLevel: number): number {
  const pixels = pixelsPerSecond(zoomLevel);
  const roughStep = totalDuration > 0 ? 96 / pixels : 1;
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60];
  return candidates.find((candidate) => candidate >= roughStep) ?? 60;
}

function buildTimelineViewportModel(
  session: SessionDefinition,
  playbackState: SessionPlaybackState,
  zoomLevel: number,
): TimelineViewportModel {
  const windows = buildSegmentWindows(session);
  const totalDuration = totalSessionDuration(session);
  const nextPixelsPerSecond = pixelsPerSecond(zoomLevel);

  const clips = windows.map((window) => {
    const clip: TimelineClipModel = {
      window,
      left: window.transitionStart * nextPixelsPerSecond,
      width: Math.max(1, segmentSpanDuration(window) * nextPixelsPerSecond),
    };
    return clip;
  });

  const tickStep = timelineTickStep(totalDuration, zoomLevel);
  const tickCount = Math.floor(totalDuration / tickStep);
  const rulerTicks = Array.from({ length: tickCount + 1 }, (_, index) => {
    const time = Math.min(totalDuration, index * tickStep);
    return {
      time,
      left: time * nextPixelsPerSecond,
      label: formatSeconds(time),
    };
  });

  const contentWidth = Math.max(1, totalDuration * nextPixelsPerSecond);
  const globalPlayheadX = Math.max(
    0,
    Math.min(playbackState.totalElapsed, totalDuration),
  ) * nextPixelsPerSecond;

  return {
    zoom: zoomLevel,
    pixelsPerSecond: nextPixelsPerSecond,
    clips,
    rulerTicks,
    contentWidth,
    totalDuration,
    globalPlayheadX,
  };
}

function findFitZoom(
  session: SessionDefinition,
  availableWidth: number,
): number {
  if (availableWidth <= 0) {
    return TIMELINE_ZOOM.default;
  }

  const totalDuration = totalSessionDuration(session);
  if (totalDuration <= 0) {
    return TIMELINE_ZOOM.default;
  }

  return Math.min(
    TIMELINE_ZOOM.max,
    Math.max(
      TIMELINE_ZOOM.min,
      Number(
        (
          availableWidth /
          Math.max(totalDuration * TIMELINE_RAIL_LAYOUT.baseSecondsWidthPx, 1)
        ).toFixed(2),
      ),
    ),
  );
}

function computeClipProgress(
  clip: TimelineClipModel,
  playbackState: SessionPlaybackState,
): number {
  if (playbackState.status === 'complete') {
    return clip.window.index <= playbackState.currentSegmentIndex ? 1 : 0;
  }

  const elapsed = playbackState.totalElapsed;
  if (elapsed <= clip.window.transitionStart) {
    return 0;
  }
  if (elapsed >= clip.window.end) {
    return 1;
  }

  return Math.min(
    1,
    Math.max(
      0,
      (elapsed - clip.window.transitionStart) /
        segmentSpanDuration(clip.window),
    ),
  );
}

function renderSegmentLaneOverlay(
  clip: TimelineClipModel,
): string {
  const customLanes = clip.window.segment.overrides.filter((lane) => lane.enabled);

  if (customLanes.length === 0) {
    return '';
  }

  return customLanes
    .map((lane) => {
      const markers = lane.keyframes
        .filter(
          (keyframe) =>
            keyframe.time >= clip.window.transitionStart &&
            keyframe.time <= clip.window.end,
        )
        .map((keyframe) => {
          const left =
            ((keyframe.time - clip.window.transitionStart) /
              segmentSpanDuration(clip.window)) *
            100;

          return `<span class="segment-lane__keyframe" style="left:${Math.max(
            0,
            Math.min(100, left),
          )}%"></span>`;
        })
        .join('');

      return `
        <div class="segment-lane" title="${escapeHtml(lane.label)}">
          <span class="segment-lane__label">${escapeHtml(
            shortSegmentOverrideTargetLabel(clip.window.segment, lane.target),
          )}</span>
          <div class="segment-lane__track">
            <span class="segment-lane__line"></span>
            ${markers}
          </div>
        </div>
      `;
    })
    .join('');
}

function renderTimelineViewport(
  session: SessionDefinition,
  selectedSegmentId: string | null,
  playbackState: SessionPlaybackState,
  zoomLevel: number,
): string {
  const viewport = buildTimelineViewportModel(session, playbackState, zoomLevel);

  return `
    <div class="timeline-canvas__chrome">
      <div class="timeline-canvas__zoom">
        <button class="ghost-button ghost-button--compact" data-action="timeline-zoom-out" type="button">-</button>
        <span class="timeline-canvas__zoom-label">${Math.round(zoomLevel * 100)}%</span>
        <button class="ghost-button ghost-button--compact" data-action="timeline-zoom-in" type="button">+</button>
        <button class="ghost-button ghost-button--compact" data-action="timeline-fit" type="button">Fit</button>
      </div>
    </div>
    <div class="timeline-scroll" data-role="timeline-scroll">
      <div class="timeline-scroll__content" style="width:${viewport.contentWidth}px">
        <div class="timeline-ruler">
          <div class="timeline-ruler__track">
            ${viewport.rulerTicks
              .map(
                (tick) => `
                  <div class="timeline-ruler__tick" style="left:${tick.left}px">
                    <span class="timeline-ruler__mark"></span>
                    <span class="timeline-ruler__label">${escapeHtml(
                      tick.label,
                    )}</span>
                  </div>
                `,
              )
              .join('')}
            <div
              class="timeline-ruler__playhead"
              style="left:${viewport.globalPlayheadX}px"
              aria-hidden="true"
            ></div>
          </div>
        </div>
        <div class="timeline-clip-track">
          ${viewport.clips
            .map((clip, index) => {
              const segment = clip.window.segment;
              const isSelected = segment.id === selectedSegmentId;
              const isActive = index === playbackState.currentSegmentIndex;
              const progress = computeClipProgress(clip, playbackState);

              return `
                <article
                  class="timeline-clip ${isSelected ? 'is-selected' : ''} ${isActive ? 'is-active' : ''}"
                  data-clip-id="${segment.id}"
                  style="left:${clip.left}px;width:${clip.width}px"
                >
                  <button
                    class="timeline-clip__button"
                    data-action="select-segment"
                    data-segment-id="${segment.id}"
                    type="button"
                  >
                    <span
                      class="timeline-clip__selected-led ${isSelected ? 'is-on' : ''}"
                      aria-hidden="true"
                    ></span>
                    <span class="timeline-clip__index">Segment ${index + 1}</span>
                    <strong class="timeline-clip__label">${escapeHtml(
                      segment.label || `Segment ${index + 1}`,
                    )}</strong>
                    <span class="timeline-clip__meta">${escapeHtml(
                      `${formatSeconds(segmentSpanDuration(clip.window))} span`,
                    )}</span>
                    <span class="timeline-clip__meta">${escapeHtml(
                      `Start ${formatSeconds(clip.window.transitionStart)}`,
                    )}</span>
                    <div class="timeline-clip__lane-region" aria-hidden="true">
                      <span
                        class="timeline-clip__playhead ${isActive ? 'is-active' : ''}"
                        style="--playhead-progress:${progress.toFixed(4)}"
                      ></span>
                      <div class="segment-card__lanes">
                        ${renderSegmentLaneOverlay(clip)}
                      </div>
                    </div>
                  </button>
                </article>
              `;
            })
            .join('')}
        </div>
      </div>
    </div>
  `;
}

function customAutomationLanes(session: SessionDefinition): AutomationLane[] {
  return session.automationLanes.filter((lane) => lane.source === 'custom');
}

function formatAutomationValue(
  target: AutomationTarget,
  value: number | boolean | NoiseModel,
): string {
  if (target === 'noise.enabled' && typeof value === 'boolean') {
    return value ? 'On' : 'Off';
  }

  if (target === 'noise.model' && typeof value === 'string') {
    return value[0]?.toUpperCase() + value.slice(1);
  }

  if (
    (target === 'masterGain' || target === 'noise.volume' || target.endsWith('.gain')) &&
    typeof value === 'number'
  ) {
    return formatPercent(value);
  }

  if (
    (target.endsWith('.carrierHz') || target.endsWith('.beatHz')) &&
    typeof value === 'number'
  ) {
    return formatHz(value);
  }

  return String(value);
}

interface AdvancedViewportModel {
  zoom: number;
  pixelsPerSecond: number;
  rulerTicks: TimelineViewportTick[];
  contentWidth: number;
  trackWidth: number;
  totalDuration: number;
  globalPlayheadX: number;
  windows: SegmentWindow[];
  lanes: AutomationLane[];
}

function buildAdvancedViewportModel(
  session: SessionDefinition,
  playbackState: SessionPlaybackState,
  zoomLevel: number,
): AdvancedViewportModel {
  const windows = buildSegmentWindows(session);
  const totalDuration = totalSessionDuration(session);
  const nextPixelsPerSecond = pixelsPerSecond(zoomLevel);
  const tickStep = timelineTickStep(totalDuration, zoomLevel);
  const tickCount = Math.floor(totalDuration / tickStep);
  const rulerTicks = Array.from({ length: tickCount + 1 }, (_, index) => {
    const time = Math.min(totalDuration, index * tickStep);
    return {
      time,
      left: ADVANCED_LAYOUT.labelWidthPx + time * nextPixelsPerSecond,
      label: formatSeconds(time),
    };
  });
  const trackWidth = Math.max(1, totalDuration * nextPixelsPerSecond);

  return {
    zoom: zoomLevel,
    pixelsPerSecond: nextPixelsPerSecond,
    rulerTicks,
    trackWidth,
    contentWidth: ADVANCED_LAYOUT.labelWidthPx + trackWidth,
    totalDuration,
    globalPlayheadX:
      ADVANCED_LAYOUT.labelWidthPx +
      Math.max(0, Math.min(playbackState.totalElapsed, totalDuration)) *
        nextPixelsPerSecond,
    windows,
    lanes: customAutomationLanes(session),
  };
}

function findAdvancedFitZoom(
  session: SessionDefinition,
  availableWidth: number,
): number {
  const usableWidth = Math.max(availableWidth - ADVANCED_LAYOUT.labelWidthPx, 0);
  if (usableWidth <= 0) {
    return TIMELINE_ZOOM.default;
  }

  return findFitZoom(session, usableWidth);
}

function renderAdvancedAutomationViewport(
  session: SessionDefinition,
  timelineUI: TimelineWorkspaceUIState,
  playbackState: SessionPlaybackState,
): string {
  const viewport = buildAdvancedViewportModel(
    session,
    playbackState,
    timelineUI.advancedZoomLevel,
  );
  const playbackProgress =
    viewport.totalDuration > 0
      ? Math.max(0, Math.min(playbackState.totalElapsed / viewport.totalDuration, 1))
      : 0;

  return `
    <div class="advanced-canvas__toolbar">
      <div class="advanced-canvas__status">
        <strong>${viewport.lanes.length} override lane${viewport.lanes.length === 1 ? '' : 's'}</strong>
        <span class="subtle">${formatSeconds(viewport.totalDuration)} total</span>
      </div>
      <div class="advanced-canvas__controls">
        <button class="secondary-action secondary-action--compact" data-action="add-lane" type="button">Add lane</button>
        <div class="timeline-canvas__zoom">
          <button class="ghost-button ghost-button--compact" data-action="advanced-zoom-out" type="button">-</button>
          <span class="timeline-canvas__zoom-label">${Math.round(timelineUI.advancedZoomLevel * 100)}%</span>
          <button class="ghost-button ghost-button--compact" data-action="advanced-zoom-in" type="button">+</button>
          <button class="ghost-button ghost-button--compact" data-action="advanced-fit" type="button">Fit</button>
        </div>
      </div>
    </div>
    <div class="advanced-scroll" data-role="advanced-scroll">
      <div class="advanced-scroll__content" style="width:${viewport.contentWidth}px">
        <div class="advanced-ruler">
          <div class="advanced-ruler__track">
            ${viewport.rulerTicks
              .map(
                (tick) => `
                  <div class="advanced-ruler__tick" style="left:${tick.left}px">
                    <span class="advanced-ruler__mark"></span>
                    <span class="advanced-ruler__label">${escapeHtml(tick.label)}</span>
                  </div>
                `,
              )
              .join('')}
            <div class="advanced-ruler__playhead" style="left:${viewport.globalPlayheadX}px"></div>
          </div>
        </div>

        <div class="advanced-segment-strip">
          ${viewport.windows
            .map((window) => {
              const left =
                ADVANCED_LAYOUT.labelWidthPx +
                window.transitionStart * viewport.pixelsPerSecond;
              const width = Math.max(
                1,
                segmentSpanDuration(window) * viewport.pixelsPerSecond,
              );
              const isActive =
                window.index === playbackState.currentSegmentIndex;
              const isSelected = window.segment.id === timelineUI.selectedSegmentId;

              return `
                <article
                  class="advanced-segment-chip ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''}"
                  data-advanced-segment-id="${window.segment.id}"
                  style="left:${left}px;width:${width}px"
                >
                  <span class="advanced-segment-chip__label">${escapeHtml(
                    window.segment.label || `Segment ${window.index + 1}`,
                  )}</span>
                </article>
              `;
            })
            .join('')}
        </div>

        <div class="advanced-lane-list">
          ${
            viewport.lanes.length === 0
              ? `
                <div class="advanced-empty-state">
                  <strong>No override lanes yet.</strong>
                  <p class="subtle">Add a custom lane to shape carrier, beat, gain, noise, or master volume over time.</p>
                </div>
              `
              : viewport.lanes
                  .map((lane) => {
                    const selectedLane = lane.id === timelineUI.selectedLaneId;
                    const lanePlayheadActive =
                      selectedLane && playbackState.status !== 'idle';

                    return `
                      <article
                        class="automation-row ${selectedLane ? 'is-selected' : ''}"
                        data-action="select-lane"
                        data-lane-id="${lane.id}"
                        data-lane-row="${lane.id}"
                      >
                        <div class="automation-row__meta">
                          <strong class="automation-row__label">${escapeHtml(
                            lane.label,
                          )}</strong>
                          <span class="automation-row__summary">
                            ${lane.enabled ? 'Enabled' : 'Bypassed'} · ${lane.interpolation}
                          </span>
                        </div>
                        <div class="automation-row__track">
                          <span class="automation-row__line"></span>
                          ${lane.keyframes
                            .map((keyframe) => {
                              const left =
                                viewport.totalDuration > 0
                                  ? (keyframe.time / viewport.totalDuration) * 100
                                  : 0;

                              return `
                                <button
                                  class="automation-row__keyframe ${timelineUI.selectedKeyframeId === keyframe.id ? 'is-selected' : ''}"
                                  data-action="select-keyframe"
                                  data-lane-id="${lane.id}"
                                  data-keyframe-id="${keyframe.id}"
                                  style="left:${Math.max(0, Math.min(100, left))}%"
                                  title="${escapeHtml(
                                    `${formatSeconds(keyframe.time)} · ${formatAutomationValue(lane.target, keyframe.value as number | boolean | NoiseModel)}`,
                                  )}"
                                  type="button"
                                ></button>
                              `;
                            })
                            .join('')}
                          <span
                            class="automation-row__playhead ${lanePlayheadActive ? 'is-active' : ''}"
                            style="--lane-progress:${playbackProgress.toFixed(4)}"
                          ></span>
                        </div>
                      </article>
                    `;
                  })
                  .join('')
          }
        </div>
      </div>
    </div>
  `;
}

function renderAdvancedInspector(
  session: SessionDefinition,
  timelineUI: TimelineWorkspaceUIState,
): string {
  const lanes = customAutomationLanes(session);
  const selectedLane =
    lanes.find((lane) => lane.id === timelineUI.selectedLaneId) ?? lanes[0] ?? null;
  const targets = collectAutomationTargets(session);

  if (!selectedLane) {
    return `
      <section class="advanced-inspector">
        <div class="advanced-inspector__empty">
          <strong>No override lane selected.</strong>
          <p class="subtle">Create a custom lane to edit advanced motion without leaving this workspace.</p>
          <button class="secondary-action secondary-action--compact" data-action="add-lane" type="button">Add lane</button>
        </div>
      </section>
    `;
  }

  const selectedKeyframe =
    selectedLane.keyframes.find(
      (keyframe) => keyframe.id === timelineUI.selectedKeyframeId,
    ) ?? selectedLane.keyframes[0] ?? null;

  return `
    <section class="advanced-inspector">
      <div class="advanced-inspector__header">
        <div>
          <p class="layer-card__eyebrow">Lane inspector</p>
          <h3>${escapeHtml(selectedLane.label)}</h3>
        </div>
      </div>

      <section class="advanced-inspector__section">
        <div class="advanced-inspector__section-header">
          <h4>Lane</h4>
          <button class="ghost-button ghost-button--compact" data-action="remove-lane" data-lane-id="${selectedLane.id}" type="button">Remove lane</button>
        </div>
        <div class="advanced-inspector__grid">
          <label class="select-field">
            <span>Target</span>
            <select data-input="lane-target" data-lane-id="${selectedLane.id}">
              ${renderAutomationTargetOptions(selectedLane.target, targets)}
            </select>
          </label>

          <label class="select-field">
            <span>Interpolation</span>
            <select data-input="lane-interpolation" data-lane-id="${selectedLane.id}">
              <option value="linear" ${selectedLane.interpolation === 'linear' ? 'selected' : ''}>Linear</option>
              <option value="step" ${selectedLane.interpolation === 'step' ? 'selected' : ''}>Step</option>
            </select>
          </label>
        </div>
        <label class="toggle advanced-inspector__toggle">
          <input data-input="lane-enabled" data-lane-id="${selectedLane.id}" type="checkbox" ${selectedLane.enabled ? 'checked' : ''} />
          <span>Lane enabled</span>
        </label>
      </section>

      <section class="advanced-inspector__section">
        <div class="advanced-inspector__section-header">
          <h4>Keyframes</h4>
          <button class="secondary-action secondary-action--compact" data-action="add-keyframe" data-lane-id="${selectedLane.id}" type="button">Add keyframe</button>
        </div>

        <div class="advanced-keyframe-list">
          ${selectedLane.keyframes
            .map(
              (keyframe) => `
                <button
                  class="advanced-keyframe-list__item ${selectedKeyframe?.id === keyframe.id ? 'is-selected' : ''}"
                  data-action="select-keyframe"
                  data-lane-id="${selectedLane.id}"
                  data-keyframe-id="${keyframe.id}"
                  type="button"
                >
                  <span>${escapeHtml(formatSeconds(keyframe.time))}</span>
                  <strong>${escapeHtml(
                    formatAutomationValue(
                      selectedLane.target,
                      keyframe.value as number | boolean | NoiseModel,
                    ),
                  )}</strong>
                </button>
              `,
            )
            .join('')}
        </div>

        ${
          selectedKeyframe
            ? `
              <div class="advanced-keyframe-editor">
                <label class="numeric-field">
                  <span>Time</span>
                  <input
                    data-input="lane-time"
                    data-lane-id="${selectedLane.id}"
                    data-keyframe-id="${selectedKeyframe.id}"
                    type="number"
                    step="0.1"
                    min="0"
                    value="${selectedKeyframe.time}"
                  />
                </label>

                <label class="numeric-field">
                  <span>Value</span>
                  ${renderKeyframeValueInput(
                    selectedLane,
                    selectedKeyframe.id,
                    selectedKeyframe.value as number | boolean | NoiseModel,
                  )}
                </label>

                <button
                  class="ghost-button ghost-button--compact"
                  data-action="remove-keyframe"
                  data-lane-id="${selectedLane.id}"
                  data-keyframe-id="${selectedKeyframe.id}"
                  type="button"
                  ${selectedLane.keyframes.length <= 1 ? 'disabled' : ''}
                >
                  Remove keyframe
                </button>
              </div>
            `
            : ''
        }
      </section>
    </section>
  `;
}

function renderAnalysisDock(currentTab: AnalysisDockTab): string {
  return `
    <section class="analysis-dock panel panel--embedded">
      <div class="analysis-dock__header">
        <div>
          <p class="layer-card__eyebrow">Analysis</p>
          <h3>Playback diagnostics</h3>
        </div>
        <div class="analysis-dock__controls">
          ${renderAnalysisDockTabToggle(currentTab)}
          <button
            class="ghost-button ghost-button--compact"
            data-action="toggle-analysis-dock"
            type="button"
          >
            Hide analysis
          </button>
        </div>
      </div>

      <div class="analysis-dock__body">
        <section class="analysis-pane ${currentTab === 'envelope' ? 'is-active' : ''}">
          <div class="viz-panel viz-panel--dock">
            <div class="viz-panel__header viz-panel__header--envelope">
              <div>
                <p class="layer-card__eyebrow">Composite Motion</p>
                <h3>Envelope waveform</h3>
              </div>
              <span class="subtle">Pure math, no signal analysis</span>
            </div>
            <canvas class="envelope-canvas" data-role="envelope-canvas" height="96"></canvas>
          </div>
        </section>

        <section class="analysis-pane ${currentTab === 'beat-map' ? 'is-active' : ''}">
          <div class="viz-panel viz-panel--dock">
            <div class="viz-panel__header">
              <div>
                <p class="layer-card__eyebrow">Diagnostic View</p>
                <h3>Beat map</h3>
              </div>
              <span class="subtle">Computed from the active sound state</span>
            </div>
            <div data-role="beat-map-primary"></div>
            <details class="viz-panel__details" data-role="beat-map-details">
              <summary>Second-order interactions</summary>
              <div data-role="beat-map-secondary"></div>
            </details>
          </div>
        </section>

        <section class="analysis-pane ${currentTab === 'metrics' ? 'is-active' : ''}">
          <div class="metrics-block metrics-block--dock">
            <div class="panel__header panel__header--compact">
              <h3>Validation readout</h3>
              <span class="subtle">Live engine snapshot</span>
            </div>
            <div class="metrics" data-role="metrics"></div>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderDiagnosticsMarkup(): string {
  return `
    <div class="advanced-grid advanced-grid--diagnostics">
      <section class="viz-panel">
        <div class="viz-panel__header">
          <div>
            <p class="layer-card__eyebrow">Diagnostic View</p>
            <h3>Beat map</h3>
          </div>
          <span class="subtle">Computed from the active sound state</span>
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

        <canvas class="envelope-canvas" data-role="envelope-canvas" height="96"></canvas>
      </section>

      <section class="metrics-block">
        <div class="panel__header panel__header--compact">
          <h3>Validation readout</h3>
          <span class="subtle">Live engine snapshot</span>
        </div>
        <div class="metrics" data-role="metrics"></div>
      </section>
    </div>
  `;
}

function renderManualHeader(
  currentPresetId: string | null,
  shareButtonLabel: string,
  playbackMode: PlaybackMode,
): string {
  return `
    <section class="hero">
      <div class="hero__meta">
        <p class="eyebrow">Neurotone</p>
        <span class="status" data-role="status-pill">Idle</span>
      </div>

      <h1>Manual listening lab.</h1>
      <p class="intro">
        Audition one selected segment directly, tune the layers by ear, and keep diagnostics close at hand.
      </p>

      <div class="hero__actions">
        <button class="transport" data-action="manual-transport">Start selected segment</button>

        <div class="hero-tools">
          <label class="select-field">
            <span>Preset</span>
            <select data-role="preset-select">
              ${renderPresetOptions(currentPresetId)}
            </select>
          </label>

          <button class="secondary-action secondary-action--compact" data-action="share-link">
            <span data-role="share-label">${shareButtonLabel}</span>
          </button>
        </div>
      </div>

      <div class="hero__controls">
        <label class="panel__tool">
          <span class="subtle">Playback mode</span>
          <span data-role="playback-mode-toggle">${renderPlaybackModeToggle(playbackMode)}</span>
        </label>
        <div class="hero__timeline-meta" data-role="header-meta"></div>
      </div>

      <p class="notice">Headphones required for binaural perception.</p>
      <p class="preset-copy" data-role="preset-description"></p>
      <div data-role="headphone-notice"></div>
    </section>
  `;
}

function renderTimelineHeader(
  session: SessionDefinition,
  shareButtonLabel: string,
  playbackMode: PlaybackMode,
): string {
  return `
    <section class="panel panel--tool-header panel--tool-header-timeline">
      <div class="tool-header tool-header--timeline">
        <div class="tool-header__row">
          <div class="tool-header__session">
            <p class="eyebrow">Timeline studio</p>
            <h2 class="tool-header__title">${escapeHtml(session.label)}</h2>
          </div>

          <div class="tool-header__controls">
            <label class="tool-header__mode">
              ${renderPlaybackModeToggle(playbackMode)}
            </label>

            <button class="ghost-button tool-header__share" data-action="share-link" type="button">
              <span data-role="share-label">${shareButtonLabel}</span>
            </button>
          </div>
        </div>
      </div>
      <div data-role="headphone-notice"></div>
    </section>
  `;
}

function renderTimelineComposerModal(
  session: SessionDefinition,
  composerDraft: ComposerDraft,
  open: boolean,
): string {
  if (!open) {
    return '';
  }

  return `
    <div class="composer-modal" data-role="composer-modal">
      <div class="composer-modal__backdrop" data-action="close-composer-modal"></div>
      <section class="composer-modal__dialog" data-action="composer-modal-surface" role="dialog" aria-modal="true" aria-label="Composer">
        <div class="composer-modal__header">
          <div>
            <p class="layer-card__eyebrow">Compose</p>
            <h2>Generate timeline</h2>
          </div>
          <button class="ghost-button ghost-button--compact" data-action="close-composer-modal" type="button">
            Close
          </button>
        </div>

        <div class="compose-stage compose-stage--modal">
        <section class="compose-panel">
          <div class="compose-panel__header">
            <div>
              <p class="layer-card__eyebrow">Input</p>
              <h3>Notes and chords</h3>
            </div>
            <span class="subtle">Use notes like A3 or C#4, chords like Am or Fmaj7, and duration suffixes like x2 or /2.</span>
          </div>

          <div class="composer-grid">
            <label class="numeric-field composer-grid__wide">
              <span>Session label</span>
              <input data-input="composer-label" type="text" value="${escapeHtml(composerDraft.label)}" />
            </label>

            <label class="numeric-field composer-grid__wide">
              <span>Step grid</span>
              <textarea data-input="composer-source" rows="5">${escapeHtml(composerDraft.source)}</textarea>
            </label>

            <label class="numeric-field">
              <span>Step duration</span>
              <input data-input="composer-step-duration" type="number" min="1" step="0.5" value="${composerDraft.stepDuration}" />
            </label>

            <label class="select-field">
              <span>Target intent</span>
              <select data-input="composer-intent">
                <option value="delta" ${composerDraft.intent === 'delta' ? 'selected' : ''}>Delta</option>
                <option value="theta" ${composerDraft.intent === 'theta' ? 'selected' : ''}>Theta</option>
                <option value="alpha" ${composerDraft.intent === 'alpha' ? 'selected' : ''}>Alpha</option>
                <option value="beta" ${composerDraft.intent === 'beta' ? 'selected' : ''}>Beta</option>
                <option value="mixed" ${composerDraft.intent === 'mixed' ? 'selected' : ''}>Mixed</option>
              </select>
            </label>
          </div>

          <div class="compose-panel__actions">
            <button class="transport transport--compact" data-action="generate-session">Generate timeline</button>
            <button class="secondary-action secondary-action--compact" data-action="close-composer-modal" type="button">
              Cancel
            </button>
          </div>
        </section>

        <aside class="compose-sidebar">
          <section class="compose-card">
            <p class="layer-card__eyebrow">Current timeline</p>
            <h3>${escapeHtml(session.label)}</h3>
            <p class="subtle">${session.segments.length} segment${session.segments.length === 1 ? '' : 's'} · ${formatSeconds(totalSessionDuration(session))} total</p>
            <p class="subtle">Use the composer to generate a segment sequence, then keep refining directly in timeline view.</p>
          </section>

          <section class="compose-card" data-role="composer-output"></section>
        </aside>
        </div>
      </section>
    </div>
  `;
}

function renderTimelineInspectorBody(
  inspectorTab: TimelineInspectorTab,
  selectedSegment: SessionSegment | undefined,
  canRemoveSegment: boolean,
): string {
  if (inspectorTab === 'segment') {
    return `
      <div class="inspector-section">
        ${
          selectedSegment
            ? renderTimelineInspectorActions(
                selectedSegment.id,
                canRemoveSegment,
              )
            : ''
        }
        <div class="segment-editor__meta" data-role="segment-meta"></div>
      </div>
    `;
  }

  return inspectorTab === 'layers'
    ? `
      <div class="inspector-section">
        <div class="layers-toolbar">
          <span class="subtle">Mini mixer</span>
          <button class="secondary-action secondary-action--compact" data-action="add-pair">Add layer</button>
        </div>
        <div class="layer-list layer-list--compact" data-role="layer-list"></div>
        <div data-role="layer-editor"></div>
      </div>
    `
    : `
      <div class="inspector-section">
        <div data-role="support-controls"></div>
      </div>
    `;
}

function renderTimelineInspectorActions(
  selectedSegmentId: string,
  canRemove: boolean,
): string {
  return `
    <div class="inspector-actions">
      <button class="ghost-button ghost-button--compact" data-action="seek-segment" data-segment-id="${selectedSegmentId}" type="button">Jump</button>
      <button class="ghost-button ghost-button--compact" data-action="add-segment-after" data-segment-id="${selectedSegmentId}" type="button">Add after</button>
      <button class="ghost-button ghost-button--compact" data-action="duplicate-segment" data-segment-id="${selectedSegmentId}" type="button">Duplicate</button>
      <button class="ghost-button ghost-button--compact" data-action="remove-segment" data-segment-id="${selectedSegmentId}" type="button" ${canRemove ? '' : 'disabled'}>Remove</button>
    </div>
  `;
}

function segmentOverrideSpanSeconds(segment: SessionSegment): number {
  return Math.max(0.5, segment.holdDuration + segment.transitionDuration);
}

function collectSegmentOverrideTargets(
  segment: SessionSegment,
): SegmentOverrideTarget[] {
  return [
    'masterGain',
    'noise.volume',
    'noise.enabled',
    'noise.model',
    ...segment.state.pairs.flatMap((pair) => [
      `pair:${pair.id}.carrierHz` as const,
      `pair:${pair.id}.beatHz` as const,
      `pair:${pair.id}.gain` as const,
    ]),
  ];
}

function describeSegmentOverrideTarget(
  segment: SessionSegment,
  target: SegmentOverrideTarget,
): string {
  if (target === 'masterGain') {
    return 'Master volume';
  }
  if (target === 'noise.volume') {
    return 'Noise level';
  }
  if (target === 'noise.enabled') {
    return 'Noise enabled';
  }
  if (target === 'noise.model') {
    return 'Noise model';
  }

  const pairMatch = target.match(/^pair:(.+)\.(carrierHz|beatHz|gain)$/);
  if (!pairMatch) {
    return target;
  }

  const [, pairId, field] = pairMatch;
  const pairIndex = segment.state.pairs.findIndex((pair) => pair.id === pairId);
  const fieldLabel =
    field === 'carrierHz' ? 'Carrier' : field === 'beatHz' ? 'Beat' : 'Gain';
  const layerLabel = pairIndex >= 0 ? `Layer ${pairIndex + 1}` : 'Missing layer';
  return `${fieldLabel} (${layerLabel})`;
}

function shortSegmentOverrideTargetLabel(
  segment: SessionSegment,
  target: SegmentOverrideTarget,
): string {
  if (target === 'masterGain') {
    return 'Master';
  }
  if (target === 'noise.volume') {
    return 'Noise';
  }
  if (target === 'noise.enabled') {
    return 'Gate';
  }
  if (target === 'noise.model') {
    return 'Model';
  }

  const pairMatch = target.match(/^pair:(.+)\.(carrierHz|beatHz|gain)$/);
  if (!pairMatch) {
    return target;
  }
  const [, pairId, field] = pairMatch;
  const pairIndex = segment.state.pairs.findIndex((pair) => pair.id === pairId);
  const prefix = field === 'carrierHz' ? 'Car' : field === 'beatHz' ? 'Beat' : 'Gain';
  return pairIndex >= 0 ? `${prefix} L${pairIndex + 1}` : `${prefix} ?`;
}

function renderSegmentOverrideTargetOptions(
  segment: SessionSegment,
  currentTarget: SegmentOverrideTarget,
  targets: SegmentOverrideTarget[],
): string {
  return targets
    .map(
      (target) => `
        <option value="${target}" ${currentTarget === target ? 'selected' : ''}>
          ${escapeHtml(describeSegmentOverrideTarget(segment, target))}
        </option>
      `,
    )
    .join('');
}

function renderSegmentOverrideInterpolationToggle(
  lane: SegmentOverrideLane,
): string {
  const interpolation = effectiveOverrideInterpolation(
    lane.target,
    lane.interpolation,
  );
  const linearDisabled = isDiscreteOverrideTarget(lane.target);

  return `
    <div class="panel__tool">
      <span class="subtle">Interpolation</span>
      <div class="segmented-control segmented-control--compact">
        <button
          class="segmented-control__button ${interpolation === 'linear' ? 'is-active' : ''}"
          data-action="set-segment-override-interpolation"
          data-lane-id="${lane.id}"
          data-value="linear"
          type="button"
          ${linearDisabled ? 'disabled' : ''}
        >
          Linear
        </button>
        <button
          class="segmented-control__button ${interpolation === 'step' ? 'is-active' : ''}"
          data-action="set-segment-override-interpolation"
          data-lane-id="${lane.id}"
          data-value="step"
          type="button"
        >
          Step
        </button>
      </div>
    </div>
  `;
}

function renderSegmentOverrideValueControl(
  lane: SegmentOverrideLane,
  keyframeId: string,
  value: number | boolean | NoiseModel,
  carrierDisplayMode: CarrierDisplayMode,
): string {
  const control = overrideValueControl(lane.target);

  if (control.kind === 'boolean') {
    return `
      <div class="panel__tool">
        <span class="subtle">Value</span>
        <div class="segmented-control segmented-control--compact">
          <button
            class="segmented-control__button ${value === true ? 'is-active' : ''}"
            data-action="set-segment-override-keyframe-boolean"
            data-lane-id="${lane.id}"
            data-keyframe-id="${keyframeId}"
            data-value="true"
            type="button"
          >
            On
          </button>
          <button
            class="segmented-control__button ${value === false ? 'is-active' : ''}"
            data-action="set-segment-override-keyframe-boolean"
            data-lane-id="${lane.id}"
            data-keyframe-id="${keyframeId}"
            data-value="false"
            type="button"
          >
            Off
          </button>
        </div>
      </div>
    `;
  }

  if (control.kind === 'enum') {
    return `
      <label class="select-field">
        <span>Value</span>
        <select
          data-input="segment-override-keyframe-value-enum"
          data-lane-id="${lane.id}"
          data-keyframe-id="${keyframeId}"
        >
          ${renderNoiseModelOptions(value as NoiseModel)}
        </select>
      </label>
    `;
  }

  const numericValue = normalizeKeyframeValue(
    lane.target,
    value,
  ) as number;

  return `
    <label class="control">
      <div class="control__row">
        <span>Value</span>
        <output data-role="segment-override-keyframe-value-output">${formatSegmentOverrideValue(
          lane.target,
          numericValue,
          carrierDisplayMode,
        )}</output>
      </div>
      <input
        data-input="segment-override-keyframe-value-slider"
        data-target="${lane.target}"
        data-lane-id="${lane.id}"
        data-keyframe-id="${keyframeId}"
        type="range"
        min="${control.min}"
        max="${control.max}"
        step="${control.step}"
        value="${numericValue}"
      />
    </label>
  `;
}

function formatSegmentOverrideValue(
  target: SegmentOverrideTarget,
  value: number | boolean | NoiseModel,
  carrierDisplayMode: CarrierDisplayMode,
): string {
  if (target.endsWith('.carrierHz') && typeof value === 'number') {
    return carrierDisplayMode === 'note'
      ? `${formatCarrierDisplay(value, 'note')} · ${formatHz(value)}`
      : formatHz(value);
  }

  return formatAutomationValue(target, value);
}

function defaultOverrideValueForTarget(
  target: SegmentOverrideTarget,
): number | boolean | NoiseModel {
  const control = overrideValueControl(target);
  if (control.kind === 'boolean') {
    return false;
  }
  if (control.kind === 'enum') {
    return 'soft';
  }
  return control.min;
}

function segmentStartValueForOverrideTarget(
  segment: SessionSegment,
  target: SegmentOverrideTarget,
): number | boolean | NoiseModel {
  if (target === 'masterGain') {
    return normalizeKeyframeValue(target, segment.state.masterGain);
  }
  if (target === 'noise.volume') {
    return normalizeKeyframeValue(target, segment.state.noise.volume);
  }
  if (target === 'noise.enabled') {
    return normalizeKeyframeValue(target, segment.state.noise.enabled);
  }
  if (target === 'noise.model') {
    return normalizeKeyframeValue(target, segment.state.noise.model);
  }

  const pairMatch = target.match(/^pair:(.+)\.(carrierHz|beatHz|gain)$/);
  if (!pairMatch) {
    return normalizeKeyframeValue(target, defaultOverrideValueForTarget(target));
  }

  const [, pairId, field] = pairMatch;
  const pair = segment.state.pairs.find((item) => item.id === pairId);
  if (!pair) {
    return normalizeKeyframeValue(target, defaultOverrideValueForTarget(target));
  }

  if (field === 'carrierHz') {
    return normalizeKeyframeValue(target, pair.carrierHz);
  }
  if (field === 'beatHz') {
    return normalizeKeyframeValue(target, pair.beatHz);
  }
  return normalizeKeyframeValue(target, pair.gain);
}

function normalizeSegmentOverrideSliderValue(
  target: SegmentOverrideTarget,
  rawValue: number,
  carrierDisplayMode: CarrierDisplayMode,
): number | boolean | NoiseModel {
  const normalized = normalizeKeyframeValue(target, rawValue);

  if (
    target.endsWith('.carrierHz') &&
    carrierDisplayMode === 'note' &&
    typeof normalized === 'number'
  ) {
    return midiToFrequency(
      clampMidiToCarrierRange(frequencyToNearestMidi(normalized)),
    );
  }

  return normalized;
}

function renderSegmentOverrideEditor(
  segment: SessionSegment,
  timelineUI: TimelineWorkspaceUIState,
  carrierDisplayMode: CarrierDisplayMode,
): string {
  const spanSeconds = segmentOverrideSpanSeconds(segment);
  const targets = collectSegmentOverrideTargets(segment);
  const lanes = segment.overrides;
  const selectedLane =
    lanes.find((lane) => lane.id === timelineUI.selectedLaneId) ?? lanes[0] ?? null;
  const selectedKeyframe =
    selectedLane?.keyframes.find((keyframe) => keyframe.id === timelineUI.selectedKeyframeId) ??
    selectedLane?.keyframes[0] ??
    null;

  return `
    <section class="segment-overrides">
      <div class="segment-overrides__header">
        <div>
          <p class="layer-card__eyebrow">Segment overrides</p>
          <h4>Selected segment lanes</h4>
        </div>
        <button class="secondary-action secondary-action--compact" data-action="add-segment-override-lane" type="button">Add lane</button>
      </div>

      ${
        lanes.length === 0
          ? '<p class="subtle">No overrides in this segment yet. Add a lane to automate carrier, beat, gain, noise, or master for this segment only.</p>'
          : `
            <div class="segment-overrides__layout">
              <div class="segment-overrides__lane-list">
                ${lanes
                  .map((lane) => {
                    const isSelected = lane.id === selectedLane?.id;
                    const interpolation = effectiveOverrideInterpolation(
                      lane.target,
                      lane.interpolation,
                    );
                    return `
                      <article class="segment-override-row ${isSelected ? 'is-selected' : ''}">
                        <button
                          class="segment-override-row__button"
                          data-action="select-segment-override-lane"
                          data-lane-id="${lane.id}"
                          type="button"
                        >
                          <strong>${escapeHtml(shortSegmentOverrideTargetLabel(segment, lane.target))}</strong>
                          <span class="subtle">${lane.enabled ? 'Enabled' : 'Bypassed'} · ${interpolation}</span>
                          <div class="segment-override-row__track">
                            <span class="segment-override-row__line"></span>
                            ${lane.keyframes
                              .map((keyframe) => {
                                const left = Math.max(
                                  0,
                                  Math.min(100, (keyframe.time / spanSeconds) * 100),
                                );
                                return `<span class="segment-override-row__dot" style="left:${left}%"></span>`;
                              })
                              .join('')}
                          </div>
                        </button>
                        <button
                          class="ghost-button ghost-button--compact"
                          data-action="remove-segment-override-lane"
                          data-lane-id="${lane.id}"
                          type="button"
                        >
                          Remove
                        </button>
                      </article>
                    `;
                  })
                  .join('')}
              </div>

              ${
                selectedLane
                  ? `
                    <section class="segment-override-inspector">
                      <div class="segment-override-inspector__lane">
                        <label class="select-field">
                          <span>Target</span>
                          <select data-input="segment-override-target" data-lane-id="${selectedLane.id}">
                            ${renderSegmentOverrideTargetOptions(segment, selectedLane.target, targets)}
                          </select>
                        </label>

                        ${renderSegmentOverrideInterpolationToggle(selectedLane)}

                        ${
                          selectedLane.target.endsWith('.carrierHz')
                            ? `
                              <label class="panel__tool inspector-section__tool">
                                <span class="subtle">Carrier display</span>
                                ${renderCarrierModeToggle(carrierDisplayMode)}
                              </label>
                            `
                            : ''
                        }

                        <label class="toggle">
                          <input data-input="segment-override-enabled" data-lane-id="${selectedLane.id}" type="checkbox" ${selectedLane.enabled ? 'checked' : ''} />
                          <span>Lane enabled</span>
                        </label>
                      </div>

                      <div class="segment-override-inspector__keyframes">
                        <div class="segment-override-inspector__keyframes-header">
                          <strong>Keyframes</strong>
                          <button class="secondary-action secondary-action--compact" data-action="add-segment-override-keyframe" data-lane-id="${selectedLane.id}" type="button">Add keyframe</button>
                        </div>

                        <div class="advanced-keyframe-list">
                          ${selectedLane.keyframes
                            .map(
                              (keyframe) => `
                                <button
                                  class="advanced-keyframe-list__item ${selectedKeyframe?.id === keyframe.id ? 'is-selected' : ''}"
                                  data-action="select-segment-override-keyframe"
                                  data-lane-id="${selectedLane.id}"
                                  data-keyframe-id="${keyframe.id}"
                                  type="button"
                                >
                                  <span>${escapeHtml(formatSeconds(keyframe.time))}</span>
                                  <strong>${escapeHtml(
                                    formatSegmentOverrideValue(
                                      selectedLane.target,
                                      keyframe.value as number | boolean | NoiseModel,
                                      carrierDisplayMode,
                                    ),
                                  )}</strong>
                                </button>
                              `,
                            )
                            .join('')}
                        </div>

                        ${
                          selectedKeyframe
                            ? `
                              <div class="advanced-keyframe-editor segment-override-keyframe-editor">
                                <label class="control">
                                  <div class="control__row">
                                    <span>Time</span>
                                    <output data-role="segment-override-keyframe-time-output">${formatSeconds(
                                      selectedKeyframe.time,
                                    )}</output>
                                  </div>
                                  <input
                                    data-input="segment-override-keyframe-time-slider"
                                    data-lane-id="${selectedLane.id}"
                                    data-keyframe-id="${selectedKeyframe.id}"
                                    type="range"
                                    step="0.1"
                                    min="0"
                                    max="${spanSeconds}"
                                    value="${selectedKeyframe.time}"
                                  />
                                </label>

                                ${renderSegmentOverrideValueControl(
                                  selectedLane,
                                  selectedKeyframe.id,
                                  selectedKeyframe.value as number | boolean | NoiseModel,
                                  carrierDisplayMode,
                                )}

                                <button
                                  class="ghost-button ghost-button--compact"
                                  data-action="remove-segment-override-keyframe"
                                  data-lane-id="${selectedLane.id}"
                                  data-keyframe-id="${selectedKeyframe.id}"
                                  type="button"
                                  ${selectedLane.keyframes.length <= 1 ? 'disabled' : ''}
                                >
                                  Remove keyframe
                                </button>
                              </div>
                            `
                            : ''
                        }
                      </div>
                    </section>
                  `
                  : ''
              }
            </div>
          `
      }
    </section>
  `;
}

function renderTimelineTabWorkspace(
  session: SessionDefinition,
  timelineUI: TimelineWorkspaceUIState,
  carrierDisplayMode: CarrierDisplayMode,
  composerDraft: ComposerDraft,
): string {
  const selectedSegment =
    session.segments.find((segment) => segment.id === timelineUI.selectedSegmentId) ??
    session.segments[0];

  return `
    <section class="panel panel--workspace panel--workspace-timeline">
      <div class="workspace-stage__header workspace-stage__header--studio workspace-stage__header--tight">
        <div>
          <p class="layer-card__eyebrow">Timeline</p>
          <h2>Clip strip and inspector</h2>
        </div>
        <div class="workspace-stage__actions">
          <span class="subtle">Desktop-first editing without leaving the main workspace.</span>
        </div>
      </div>

      <div data-role="generated-summary"></div>

      <div class="timeline-edit-layout timeline-edit-layout--desktop">
        <div class="timeline-edit-layout__main">
          <section class="transport-row" data-role="timeline-transport"></section>
          <section class="timeline-strip-block">
            <div class="timeline-strip-block__header">
              <div>
                <p class="layer-card__eyebrow">Segment strip</p>
                <h3>Timeline clips</h3>
              </div>
              <div class="timeline-strip-block__actions">
                <button class="ghost-button ghost-button--compact" data-action="open-composer-modal" type="button">
                  Open composer
                </button>
                <span class="subtle">${session.segments.length} segment${session.segments.length === 1 ? '' : 's'} · ${formatSeconds(totalSessionDuration(session))}</span>
              </div>
            </div>
            <div class="timeline-strip-block__body">
              <div data-role="timeline-canvas"></div>
              <div data-role="segment-overrides"></div>
            </div>
          </section>
        </div>

        <section class="inspector-panel">
          <div class="inspector-panel__header">
            <div>
              <p class="layer-card__eyebrow">Inspector</p>
              <h3 data-role="selected-segment-title">Segment</h3>
            </div>
            ${renderInspectorTabToggle(timelineUI.inspectorTab)}
          </div>

          <div class="inspector-panel__body">
            ${renderTimelineInspectorBody(
              timelineUI.inspectorTab,
              selectedSegment,
              session.segments.length > 1,
            )}
          </div>
        </section>
      </div>
      ${renderTimelineComposerModal(session, composerDraft, timelineUI.composerModalOpen)}
    </section>
  `;
}

function renderTimelineAdvancedTab(
  session: SessionDefinition,
  timelineUI: TimelineWorkspaceUIState,
): string {
  return `
    <section class="panel panel--workspace panel--workspace-advanced ${timelineUI.analysisDockOpen ? 'has-analysis-dock' : ''}">
      <div class="workspace-stage__header workspace-stage__header--studio workspace-stage__header--tight">
        <div>
          <p class="layer-card__eyebrow">Advanced</p>
          <h2>Automation editor</h2>
        </div>
        <div class="workspace-stage__actions">
          <span class="subtle">Override lane editing with optional analysis.</span>
          <button
            class="ghost-button ghost-button--compact"
            data-action="toggle-analysis-dock"
            type="button"
          >
            ${timelineUI.analysisDockOpen ? 'Hide analysis' : 'Show analysis'}
          </button>
        </div>
      </div>

      <section class="transport-row" data-role="timeline-transport"></section>

      <div class="advanced-editor-layout">
        <section class="panel panel--embedded panel--advanced-workspace">
          <div data-role="advanced-canvas"></div>
        </section>

        <aside class="advanced-side-panel" data-role="advanced-inspector"></aside>
      </div>

      ${timelineUI.analysisDockOpen ? renderAnalysisDock(timelineUI.analysisDockTab) : ''}
    </section>
  `;
}

function renderManualWorkspace(
  session: SessionDefinition,
  selectedSegmentId: string | null,
  carrierDisplayMode: CarrierDisplayMode,
): string {
  const selectedIndex = Math.max(
    0,
    session.segments.findIndex((segment) => segment.id === selectedSegmentId),
  );

  return `
    <section class="panel panel--manual-workspace">
      <div class="panel__header">
        <div>
          <p class="layer-card__eyebrow">Manual Mode</p>
          <h2>Selected segment lab</h2>
        </div>
        <div class="panel__tools">
          ${
            session.segments.length > 1
              ? `
                <label class="select-field">
                  <span>Selected segment</span>
                  <select data-input="manual-segment-select">
                    ${session.segments
                      .map(
                        (segment, index) => `
                          <option value="${segment.id}" ${
                            segment.id === selectedSegmentId ? 'selected' : ''
                          }>
                            Segment ${index + 1}: ${escapeHtml(segment.label || `Segment ${index + 1}`)}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
              `
              : ''
          }
          <label class="panel__tool">
            <span class="subtle">Carrier display</span>
            ${renderCarrierModeToggle(carrierDisplayMode)}
          </label>
        </div>
      </div>

      <div class="manual-workspace__summary">
        <p class="subtle">Auditioning segment ${selectedIndex + 1} of ${session.segments.length}. Manual mode plays only the currently selected segment.</p>
      </div>

      <div class="segment-editor__meta" data-role="segment-meta"></div>
      <div class="stack-note" data-role="stack-note"></div>
      <div class="layer-list" data-role="layer-list"></div>
      <button class="secondary-action" data-action="add-pair">Add layer</button>
      <div data-role="support-controls"></div>
    </section>
    <section class="panel panel--diagnostics">
      ${renderDiagnosticsMarkup()}
    </section>
  `;
}

function renderComposerOutput(
  composerExplanation: string[],
  session: SessionDefinition,
): string {
  const summary = `${session.segments.length} segment${session.segments.length === 1 ? '' : 's'} · ${formatSeconds(totalSessionDuration(session))} total`;

  return `
    <div class="composer-note">
      ${
        composerExplanation.length > 0
          ? composerExplanation
              .map((line) => `<p>${escapeHtml(line)}</p>`)
              .join('')
          : `<p>Generate a timeline from notes or named chords, then move into Edit to shape segments and advanced motion.</p>`
      }
      <p>${escapeHtml(summary)}</p>
    </div>
  `;
}

function renderGeneratedSummary(
  session: SessionDefinition,
  composerExplanation: string[],
): string {
  if (
    session.metadata?.source !== 'generated' &&
    composerExplanation.length === 0
  ) {
    return '';
  }

  return `
    <div class="session-summary-strip">
      <div class="session-summary-strip__meta">
        <p class="layer-card__eyebrow">Session summary</p>
        <strong>${escapeHtml(session.label)}</strong>
        <span class="subtle">${session.segments.length} segment${session.segments.length === 1 ? '' : 's'} · ${formatSeconds(totalSessionDuration(session))} total</span>
      </div>
      <div class="session-summary-strip__copy">
        ${
          composerExplanation.length > 0
            ? composerExplanation
                .slice(0, 1)
                .map((line) => `<p class="subtle">${escapeHtml(line)}</p>`)
                .join('')
            : '<p class="subtle">Generated from musical input and ready for segment-level refinement.</p>'
        }
      </div>
    </div>
  `;
}

function renderTimelineTransport(
  playbackState: SessionPlaybackState,
  loop: boolean,
): string {
  const playing = playbackState.status === 'playing';
  const paused = playbackState.status === 'paused';
  const idle = playbackState.status === 'idle';

  return `
    <div class="transport-row__cluster transport-row__cluster--primary">
      <span class="transport-row__label">Transport</span>
      <button class="transport transport--compact" data-action="play-timeline" type="button" ${playing ? 'disabled' : ''}>Play</button>
      <button class="ghost-button ghost-button--compact" data-action="pause-timeline" type="button" ${!playing ? 'disabled' : ''}>Pause</button>
      <button class="ghost-button ghost-button--compact" data-action="resume-timeline" type="button" ${!paused ? 'disabled' : ''}>Resume</button>
      <button class="ghost-button ghost-button--compact" data-action="stop-timeline" type="button" ${idle ? 'disabled' : ''}>Stop</button>
      <button class="ghost-button ghost-button--compact" data-action="jump-selected" type="button">Jump to selected</button>
    </div>

    <div class="transport-row__cluster transport-row__cluster--meta">
      <label class="toggle">
        <input data-input="session-loop" type="checkbox" ${loop ? 'checked' : ''} />
        <span>Loop</span>
      </label>
      <div class="transport-row__readout" data-role="timeline-readout"></div>
    </div>
  `;
}

export function createApp(root: HTMLElement): void {
  const engine = new BinauralEngine();
  const sequencer = new SessionSequencer(engine);

  let carrierDisplayMode: CarrierDisplayMode = 'note';
  let restored =
    decodeShareableState(window.location.hash) ??
    loadStoredState() ??
    createInitialShareableState();
  let playbackMode: PlaybackMode = restored.mode;
  let currentPresetId: string | null = restored.presetId;
  let session: SessionDefinition = restored.session;
  let composerDraft: ComposerDraft = restored.composer;
  let timelineUI = loadTimelineWorkspaceUIState(session);
  let headphoneNoticeVisible = !hasSeenHeadphoneNotice();
  let shareButtonLabel = 'Copy share link';
  let shareFeedbackTimeoutId: number | null = null;
  let envelopeDurationSeconds = 5;
  let envelopeSamples = computeEnvelope([], envelopeDurationSeconds, 0);
  let animationFrameId: number | null = null;
  let engineState: EngineSnapshot = engine.getSnapshot();
  let composerExplanation: string[] = [];

  root.innerHTML = `
    <main class="shell">
      <div data-role="header-shell"></div>
      <div data-role="workspace-shell"></div>
    </main>
  `;

  const headerShell = root.querySelector<HTMLElement>('[data-role="header-shell"]');
  const workspaceShell = root.querySelector<HTMLElement>('[data-role="workspace-shell"]');

  if (!headerShell || !workspaceShell) {
    throw new Error('App shell did not initialize.');
  }

  const ensureTimelineUI = (
    partial?: Partial<TimelineWorkspaceUIState>,
    nextSession: SessionDefinition = session,
  ): void => {
    timelineUI = normalizeTimelineWorkspaceUIState(
      {
        ...timelineUI,
        ...partial,
      },
      nextSession,
    );
  };

  const selectedSegment = (): SessionSegment =>
    session.segments.find((segment) => segment.id === timelineUI.selectedSegmentId) ??
    session.segments[0] ??
    createSessionSegment();

  const selectedSegmentIndex = (): number =>
    Math.max(
      0,
      session.segments.findIndex((segment) => segment.id === selectedSegment().id),
    );

  const selectedState = (): SessionSoundState => selectedSegment().state;

  const currentShareableState = (): ShareableState => ({
    presetId: currentPresetId,
    mode: playbackMode,
    session,
    composer: composerDraft,
  });

  const persistAppState = (): void => {
    const shareableState = currentShareableState();
    saveStoredState(shareableState);
    saveTimelineWorkspaceUIState(timelineUI, session);
    const encodedState = encodeShareableState(shareableState);
    window.history.replaceState(null, '', `#${encodedState}`);
  };

  const syncEngineSnapshot = (): void => {
    engineState = engine.getSnapshot();
  };

  const applySelectedSegmentToEngine = (): void => {
    const state = selectedState();
    engine.setBaseParams({
      pairs: state.pairs,
      masterGain: state.masterGain,
    });
    engine.setNoise(state.noise);
    syncEngineSnapshot();
  };

  const activePlaybackState = (): SessionPlaybackState =>
    sequencer.getPlaybackState();

  const timelineIsPlaying = (): boolean =>
    playbackMode === 'timeline' &&
    activePlaybackState().status === 'playing';

  const headerMetaText = (): string => {
    if (playbackMode === 'manual') {
      return `Segment ${selectedSegmentIndex() + 1} selected for manual audition`;
    }

    const playbackState = activePlaybackState();
    return `${formatSeconds(playbackState.totalElapsed)} / ${formatSeconds(playbackState.totalDuration)} · Segment ${playbackState.currentSegmentIndex + 1} · ${playbackState.currentSegmentPhase}`;
  };

  const syncHeader = (): void => {
    const statusPill = root.querySelector<HTMLElement>('[data-role="status-pill"]');
    const shareLabel = root.querySelector<HTMLElement>('[data-role="share-label"]');
    const headerMeta = root.querySelector<HTMLElement>('[data-role="header-meta"]');
    const presetSelect = root.querySelector<HTMLSelectElement>('[data-role="preset-select"]');
    const presetDescription = root.querySelector<HTMLElement>('[data-role="preset-description"]');
    const headphoneNotice = root.querySelector<HTMLElement>('[data-role="headphone-notice"]');

    if (statusPill) {
      const timelineState = activePlaybackState();
      const running =
        playbackMode === 'timeline'
          ? timelineState.status === 'playing'
          : engineState.playbackState === 'running';
      statusPill.textContent =
        playbackMode === 'timeline'
          ? timelineState.status === 'complete'
            ? 'Complete'
            : timelineState.status === 'paused'
              ? 'Paused'
              : timelineState.status === 'playing'
                ? 'Playing'
                : 'Idle'
          : engineState.playbackState === 'running'
            ? 'Running'
            : 'Idle';
      statusPill.dataset.state = running ? 'running' : 'idle';
    }

    if (shareLabel) {
      shareLabel.textContent = shareButtonLabel;
    }

    if (headerMeta) {
      headerMeta.textContent = headerMetaText();
    }

    if (presetSelect) {
      presetSelect.innerHTML = renderPresetOptions(currentPresetId);
      presetSelect.value = currentPresetId ?? 'custom';
    }

    if (presetDescription) {
      if (currentPresetId) {
        const preset = getPresetById(currentPresetId);
        presetDescription.textContent = preset?.description ?? 'Preset ready.';
      } else {
        presetDescription.textContent =
          playbackMode === 'manual'
            ? 'Manual mode plays only the currently selected segment.'
            : '';
      }
    }

    if (headphoneNotice) {
      headphoneNotice.innerHTML = headphoneNoticeVisible
        ? `
          <div class="notice-banner">
            <div>
              <strong>Use headphones.</strong>
              <p>This tool depends on stereo separation. Speakers will collapse the effect.</p>
            </div>
            <button class="ghost-button" data-action="dismiss-headphone-notice">I understand</button>
          </div>
        `
        : '';
    }
  };

  const syncSegmentMeta = (): void => {
    const container = root.querySelector<HTMLElement>('[data-role="segment-meta"]');
    const selectedTitle = root.querySelector<HTMLElement>('[data-role="selected-segment-title"]');
    if (!container) {
      return;
    }

    const segment = selectedSegment();
    if (selectedTitle) {
      selectedTitle.textContent = segment.label || `Segment ${selectedSegmentIndex() + 1}`;
    }

    if (!container.querySelector('[data-input="segment-label"]')) {
      container.innerHTML = renderSegmentMetaControls(segment);
    }

    const holdDuration = Math.max(1, segment.holdDuration);
    const transitionDuration = Math.min(
      holdDuration,
      Math.max(0, segment.transitionDuration),
    );

    const labelInput = container.querySelector<HTMLInputElement>('[data-input="segment-label"]');
    const holdNumber = container.querySelector<HTMLInputElement>('[data-input="segment-hold-duration"]');
    const holdSlider = container.querySelector<HTMLInputElement>('[data-input="segment-hold-slider"]');
    const holdOutput = container.querySelector<HTMLOutputElement>('[data-role="segment-hold-output"]');
    const transitionSlider = container.querySelector<HTMLInputElement>('[data-input="segment-transition-slider"]');
    const transitionOutput = container.querySelector<HTMLOutputElement>('[data-role="segment-transition-output"]');

    if (labelInput) {
      labelInput.value = segment.label || '';
    }
    if (holdNumber) {
      holdNumber.value = String(holdDuration);
    }
    if (holdSlider) {
      holdSlider.value = String(holdDuration);
    }
    if (holdOutput) {
      holdOutput.value = formatSeconds(holdDuration);
    }
    if (transitionSlider) {
      transitionSlider.max = String(holdDuration);
      transitionSlider.value = String(transitionDuration);
    }
    if (transitionOutput) {
      transitionOutput.value = formatSeconds(transitionDuration);
    }
  };

  const syncSegmentOverrides = (): void => {
    const container = root.querySelector<HTMLElement>('[data-role="segment-overrides"]');
    if (!container) {
      return;
    }

    container.innerHTML = renderSegmentOverrideEditor(
      selectedSegment(),
      timelineUI,
      carrierDisplayMode,
    );
  };

  const syncPairCard = (pair: TonePairSnapshot): void => {
    const card = root.querySelector<HTMLElement>(`[data-pair-card="${pair.id}"]`);
    if (!card) {
      return;
    }

    const title = card.querySelector<HTMLHeadingElement>('h3');
    const carrierOutput = card.querySelector<HTMLOutputElement>('[data-role="carrier-output"]');
    const carrierHint = card.querySelector<HTMLElement>('[data-role="carrier-hint"]');
    const beatOutput = card.querySelector<HTMLOutputElement>('[data-role="beat-output"]');
    const gainOutput = card.querySelector<HTMLOutputElement>('[data-role="gain-output"]');
    const leftReadout = card.querySelector<HTMLElement>('[data-role="left-readout"]');
    const rightReadout = card.querySelector<HTMLElement>('[data-role="right-readout"]');
    const readout = card.querySelector<HTMLElement>('[data-role="pair-readout"]');
    const carrierRange = card.querySelector<HTMLInputElement>('input[type="range"][data-input="carrierHz"]');
    const carrierEditor = card.querySelector<HTMLInputElement>('input[data-role="carrier-editor"]');
    const beatRange = card.querySelector<HTMLInputElement>('input[type="range"][data-input="beatHz"]');
    const beatNumber = card.querySelector<HTMLInputElement>('input[type="number"][data-input="beatHz"]');
    const gainRange = card.querySelector<HTMLInputElement>('input[type="range"][data-input="gain"]');
    const carrierDisplay = formatCarrierDisplay(pair.carrierHz, carrierDisplayMode);

    if (title) {
      title.textContent = `Carrier ${carrierDisplay}`;
    }
    if (carrierOutput) {
      carrierOutput.value = carrierDisplay;
    }
    if (carrierHint) {
      carrierHint.textContent = formatHz(pair.carrierHz);
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
      carrierRange.min =
        carrierDisplayMode === 'note'
          ? String(clampMidiToCarrierRange(frequencyToNearestMidi(UI_LIMITS.carrierSliderMin)))
          : String(UI_LIMITS.carrierSliderMin);
      carrierRange.max =
        carrierDisplayMode === 'note'
          ? String(clampMidiToCarrierRange(frequencyToNearestMidi(UI_LIMITS.carrierSliderMax)))
          : String(UI_LIMITS.carrierSliderMax);
      carrierRange.value =
        carrierDisplayMode === 'note'
          ? String(clampMidiToCarrierRange(frequencyToNearestMidi(pair.carrierHz)))
          : String(Math.min(UI_LIMITS.carrierSliderMax, Math.max(UI_LIMITS.carrierSliderMin, pair.carrierHz)));
    }
    if (carrierEditor) {
      carrierEditor.value =
        carrierDisplayMode === 'note'
          ? frequencyToNoteLabel(pair.carrierHz)
          : String(pair.carrierHz);
    }
    if (beatRange) {
      beatRange.value = String(Math.min(UI_LIMITS.beatSliderMax, Math.max(UI_LIMITS.beatSliderMin, pair.beatHz)));
    }
    if (beatNumber) {
      beatNumber.value = String(pair.beatHz);
    }
    if (gainRange) {
      gainRange.value = String(pair.gain);
    }
  };

  const syncLayerEditor = (renderLayers = false): void => {
    const layerList = root.querySelector<HTMLElement>('[data-role="layer-list"]');
    const layerEditor = root.querySelector<HTMLElement>('[data-role="layer-editor"]');
    if (!layerList) {
      return;
    }

    const pairs = selectedState().pairs.map(computeTonePairSnapshot);
    if (!layerEditor) {
      if (renderLayers || !layerList.querySelector('[data-pair-card]')) {
        layerList.innerHTML = pairs
          .map((pair) => renderPairCard(pair, pairs.length > 1, carrierDisplayMode))
          .join('');
      }

      pairs.forEach(syncPairCard);
      return;
    }

    const selectedPair =
      pairs.find((pair) => pair.id === timelineUI.selectedPairId) ?? pairs[0] ?? null;

    if (renderLayers || !layerList.querySelector('[data-pair-row]')) {
      layerList.innerHTML = pairs
        .map((pair) =>
          renderLayerMixerRow(
            pair,
            pair.id === selectedPair?.id,
            carrierDisplayMode,
            pairs.length > 1,
          ),
        )
        .join('');
    }

    pairs.forEach((pair) => {
      const row = layerList.querySelector<HTMLElement>(`[data-pair-row="${pair.id}"]`);
      if (!row) {
        return;
      }
      row.classList.toggle('is-selected', pair.id === selectedPair?.id);
      const label = row.querySelector<HTMLElement>('.mixer-row__label');
      const beat = row.querySelector<HTMLElement>('[data-role="row-beat"]');
      const gain = row.querySelector<HTMLElement>('[data-role="row-gain"]');
      if (label) {
        label.textContent = formatCarrierDisplay(pair.carrierHz, carrierDisplayMode);
      }
      if (beat) {
        beat.textContent = formatHz(pair.beatHz);
      }
      if (gain) {
        gain.textContent = formatPercent(pair.gain);
      }
    });

    if (!selectedPair) {
      layerEditor.innerHTML = '';
      return;
    }

    if (
      renderLayers ||
      layerEditor.dataset.pairId !== selectedPair.id ||
      !layerEditor.querySelector('[data-role="mini-title"]')
    ) {
      layerEditor.innerHTML = renderLayerMiniMixer(
        selectedPair,
        carrierDisplayMode,
      );
    }

    layerEditor.dataset.pairId = selectedPair.id;

    const title = layerEditor.querySelector<HTMLElement>('[data-role="mini-title"]');
    const carrierOutput = layerEditor.querySelector<HTMLOutputElement>('[data-role="carrier-output"]');
    const carrierHint = layerEditor.querySelector<HTMLElement>('[data-role="carrier-hint"]');
    const beatOutput = layerEditor.querySelector<HTMLOutputElement>('[data-role="beat-output"]');
    const gainOutput = layerEditor.querySelector<HTMLOutputElement>('[data-role="gain-output"]');
    const leftReadout = layerEditor.querySelector<HTMLElement>('[data-role="left-readout"]');
    const rightReadout = layerEditor.querySelector<HTMLElement>('[data-role="right-readout"]');
    const readout = layerEditor.querySelector<HTMLElement>('[data-role="pair-readout"]');
    const carrierRange = layerEditor.querySelector<HTMLInputElement>('input[type="range"][data-input="carrierHz"]');
    const carrierEditor = layerEditor.querySelector<HTMLInputElement>('input[data-role="carrier-editor"]');
    const beatRange = layerEditor.querySelector<HTMLInputElement>('input[type="range"][data-input="beatHz"]');
    const beatNumber = layerEditor.querySelector<HTMLInputElement>('input[type="number"][data-input="beatHz"]');
    const gainRange = layerEditor.querySelector<HTMLInputElement>('input[type="range"][data-input="gain"]');
    const gainNumber = layerEditor.querySelector<HTMLInputElement>('input[type="number"][data-input="gain"]');
    const carrierDisplay = formatCarrierDisplay(selectedPair.carrierHz, carrierDisplayMode);

    if (title) {
      title.textContent = `Carrier ${carrierDisplay}`;
    }
    if (carrierOutput) {
      carrierOutput.value = carrierDisplay;
    }
    if (carrierHint) {
      carrierHint.textContent = formatHz(selectedPair.carrierHz);
    }
    if (beatOutput) {
      beatOutput.value = formatHz(selectedPair.beatHz);
    }
    if (gainOutput) {
      gainOutput.value = formatPercent(selectedPair.gain);
    }
    if (leftReadout) {
      leftReadout.textContent = `L ${formatHz(selectedPair.leftHz)}`;
    }
    if (rightReadout) {
      rightReadout.textContent = `R ${formatHz(selectedPair.rightHz)}`;
    }
    if (readout) {
      readout.classList.toggle(
        'readout--muted',
        selectedPair.carrierHz < UI_LIMITS.carrierSliderMin,
      );
    }
    if (carrierRange) {
      carrierRange.min =
        carrierDisplayMode === 'note'
          ? String(clampMidiToCarrierRange(frequencyToNearestMidi(UI_LIMITS.carrierSliderMin)))
          : String(UI_LIMITS.carrierSliderMin);
      carrierRange.max =
        carrierDisplayMode === 'note'
          ? String(clampMidiToCarrierRange(frequencyToNearestMidi(UI_LIMITS.carrierSliderMax)))
          : String(UI_LIMITS.carrierSliderMax);
      carrierRange.value =
        carrierDisplayMode === 'note'
          ? String(clampMidiToCarrierRange(frequencyToNearestMidi(selectedPair.carrierHz)))
          : String(Math.min(UI_LIMITS.carrierSliderMax, Math.max(UI_LIMITS.carrierSliderMin, selectedPair.carrierHz)));
    }
    if (carrierEditor) {
      carrierEditor.value =
        carrierDisplayMode === 'note'
          ? frequencyToNoteLabel(selectedPair.carrierHz)
          : String(selectedPair.carrierHz);
    }
    if (beatRange) {
      beatRange.value = String(Math.min(UI_LIMITS.beatSliderMax, Math.max(UI_LIMITS.beatSliderMin, selectedPair.beatHz)));
    }
    if (beatNumber) {
      beatNumber.value = String(selectedPair.beatHz);
    }
    if (gainRange) {
      gainRange.value = String(selectedPair.gain);
    }
    if (gainNumber) {
      gainNumber.value = String(selectedPair.gain);
    }
  };

  const syncSupportControls = (renderSupport = false): void => {
    const supportControls = root.querySelector<HTMLElement>('[data-role="support-controls"]');
    if (!supportControls) {
      return;
    }

    const state = selectedState();
    if (renderSupport) {
      supportControls.innerHTML = renderSupportControls(
        state.noise,
        state.masterGain,
      );
    }

    const noiseCheckbox = supportControls.querySelector<HTMLInputElement>('input[type="checkbox"][data-input="noiseEnabled"]');
    const noiseRange = supportControls.querySelector<HTMLInputElement>('input[type="range"][data-input="noiseVolume"]');
    const noiseOutput = supportControls.querySelector<HTMLOutputElement>('[data-role="noise-output"]');
    const noiseModel = supportControls.querySelector<HTMLSelectElement>('select[data-input="noiseModel"]');
    const masterRange = supportControls.querySelector<HTMLInputElement>('input[type="range"][data-input="masterGain"]');
    const masterOutput = supportControls.querySelector<HTMLOutputElement>('[data-role="master-output"]');

    if (noiseCheckbox) {
      noiseCheckbox.checked = state.noise.enabled;
    }
    if (noiseRange) {
      noiseRange.value = String(state.noise.volume);
    }
    if (noiseOutput) {
      noiseOutput.value = formatPercent(state.noise.volume);
    }
    if (noiseModel) {
      noiseModel.value = state.noise.model;
    }
    if (masterRange) {
      masterRange.value = String(state.masterGain);
    }
    if (masterOutput) {
      masterOutput.value = formatPercent(state.masterGain);
    }
  };

  const syncTimelineCanvas = (): void => {
    const canvas = root.querySelector<HTMLElement>('[data-role="timeline-canvas"]');
    if (!canvas) {
      return;
    }

    canvas.innerHTML = renderTimelineViewport(
      session,
      timelineUI.selectedSegmentId,
      activePlaybackState(),
      timelineUI.zoomLevel,
    );

    const scrollContainer = root.querySelector<HTMLElement>('[data-role="timeline-scroll"]');
    if (scrollContainer) {
      const nextLeft = Math.max(0, timelineUI.viewportLeft);
      scrollContainer.scrollLeft = nextLeft;
    }
  };

  const syncAdvancedCanvas = (): void => {
    const canvas = root.querySelector<HTMLElement>('[data-role="advanced-canvas"]');
    if (!canvas) {
      return;
    }

    canvas.innerHTML = renderAdvancedAutomationViewport(
      session,
      timelineUI,
      activePlaybackState(),
    );

    const scrollContainer = root.querySelector<HTMLElement>('[data-role="advanced-scroll"]');
    if (scrollContainer) {
      scrollContainer.scrollLeft = Math.max(0, timelineUI.advancedViewportLeft);
    }
  };

  const syncAdvancedInspector = (): void => {
    const inspector = root.querySelector<HTMLElement>('[data-role="advanced-inspector"]');
    if (!inspector) {
      return;
    }

    inspector.innerHTML = renderAdvancedInspector(session, timelineUI);
  };

  const syncTimelineTransport = (): void => {
    const transports = root.querySelectorAll<HTMLElement>(
      '[data-role="timeline-transport"]',
    );
    if (transports.length === 0) {
      return;
    }

    const playbackState = activePlaybackState();
    const playing = playbackState.status === 'playing';
    const paused = playbackState.status === 'paused';
    const idle = playbackState.status === 'idle';

    transports.forEach((transport) => {
      if (!transport.querySelector('[data-role="timeline-readout"]')) {
        transport.innerHTML = renderTimelineTransport(playbackState, session.loop);
      }

      const playButton = transport.querySelector<HTMLButtonElement>('[data-action="play-timeline"]');
      const pauseButton = transport.querySelector<HTMLButtonElement>('[data-action="pause-timeline"]');
      const resumeButton = transport.querySelector<HTMLButtonElement>('[data-action="resume-timeline"]');
      const stopButton = transport.querySelector<HTMLButtonElement>('[data-action="stop-timeline"]');
      const loopCheckbox = transport.querySelector<HTMLInputElement>('input[data-input="session-loop"]');
      const readout = transport.querySelector<HTMLElement>('[data-role="timeline-readout"]');

      if (playButton) {
        playButton.disabled = playing;
      }
      if (pauseButton) {
        pauseButton.disabled = !playing;
      }
      if (resumeButton) {
        resumeButton.disabled = !paused;
      }
      if (stopButton) {
        stopButton.disabled = idle;
      }
      if (loopCheckbox) {
        loopCheckbox.checked = session.loop;
      }
      if (readout) {
        readout.textContent = `${formatSeconds(playbackState.totalElapsed)} / ${formatSeconds(playbackState.totalDuration)} · Segment ${playbackState.currentSegmentIndex + 1} · ${playbackState.currentSegmentPhase}`;
      }
    });
  };

  const syncTimelinePlaybackVisuals = (): void => {
    const canvas = root.querySelector<HTMLElement>('[data-role="timeline-canvas"]');
    if (!canvas) {
      return;
    }

    const playbackState = activePlaybackState();
    const viewport = buildTimelineViewportModel(
      session,
      playbackState,
      timelineUI.zoomLevel,
    );
    const rulerPlayhead = canvas.querySelector<HTMLElement>('.timeline-ruler__playhead');
    if (rulerPlayhead) {
      rulerPlayhead.style.left = `${viewport.globalPlayheadX}px`;
    }

    viewport.clips.forEach((clip) => {
      const segmentId = clip.window.segment.id;
      const clipElement = canvas.querySelector<HTMLElement>(`[data-clip-id="${segmentId}"]`);
      if (!clipElement) {
        return;
      }

      clipElement.classList.toggle(
        'is-active',
        clip.window.index === playbackState.currentSegmentIndex,
      );
      clipElement.classList.toggle(
        'is-selected',
        segmentId === timelineUI.selectedSegmentId,
      );

      const localPlayhead = clipElement.querySelector<HTMLElement>('.timeline-clip__playhead');
      const progress = computeClipProgress(clip, playbackState);
      if (localPlayhead) {
        localPlayhead.style.setProperty('--playhead-progress', progress.toFixed(4));
        localPlayhead.classList.toggle(
          'is-active',
          clip.window.index === playbackState.currentSegmentIndex,
        );
      }
    });
  };

  const syncAdvancedPlaybackVisuals = (): void => {
    const canvas = root.querySelector<HTMLElement>('[data-role="advanced-canvas"]');
    if (!canvas) {
      return;
    }

    const playbackState = activePlaybackState();
    const viewport = buildAdvancedViewportModel(
      session,
      playbackState,
      timelineUI.advancedZoomLevel,
    );
    const rulerPlayhead = canvas.querySelector<HTMLElement>('.advanced-ruler__playhead');
    if (rulerPlayhead) {
      rulerPlayhead.style.left = `${viewport.globalPlayheadX}px`;
    }

    const progress =
      viewport.totalDuration > 0
        ? Math.max(0, Math.min(playbackState.totalElapsed / viewport.totalDuration, 1))
        : 0;

    viewport.windows.forEach((window) => {
      const chip = canvas.querySelector<HTMLElement>(
        `[data-advanced-segment-id="${window.segment.id}"]`,
      );
      if (!chip) {
        return;
      }

      chip.classList.toggle(
        'is-active',
        window.index === playbackState.currentSegmentIndex,
      );
      chip.classList.toggle(
        'is-selected',
        window.segment.id === timelineUI.selectedSegmentId,
      );
    });

    viewport.lanes.forEach((lane) => {
      const row = canvas.querySelector<HTMLElement>(`[data-lane-row="${lane.id}"]`);
      if (!row) {
        return;
      }

      const selected = lane.id === timelineUI.selectedLaneId;
      row.classList.toggle('is-selected', selected);
      const localPlayhead = row.querySelector<HTMLElement>('.automation-row__playhead');
      if (localPlayhead) {
        localPlayhead.style.setProperty('--lane-progress', progress.toFixed(4));
        localPlayhead.classList.toggle(
          'is-active',
          selected && playbackState.status !== 'idle',
        );
      }
    });
  };

  const syncComposerOutput = (): void => {
    const composerOutput = root.querySelector<HTMLElement>('[data-role="composer-output"]');
    if (!composerOutput) {
      return;
    }

    composerOutput.innerHTML = renderComposerOutput(composerExplanation, session);
  };

  const syncGeneratedSummary = (): void => {
    const summary = root.querySelector<HTMLElement>('[data-role="generated-summary"]');
    if (!summary) {
      return;
    }

    summary.innerHTML = renderGeneratedSummary(session, composerExplanation);
  };

  const drawEnvelopeFrame = (timestampMs: number): void => {
    const canvas = root.querySelector<HTMLCanvasElement>('[data-role="envelope-canvas"]');
    if (!canvas) {
      return;
    }

    const playbackProgress =
      playbackMode === 'timeline'
        ? timelineIsPlaying()
          ? ((activePlaybackState().totalElapsed % envelopeDurationSeconds) /
              envelopeDurationSeconds)
          : -1
        : engineState.playbackState === 'running'
          ? ((timestampMs / 1000) % envelopeDurationSeconds) / envelopeDurationSeconds
        : -1;

    drawEnvelope(canvas, envelopeSamples, playbackProgress);

    if (
      (playbackMode === 'timeline' && timelineIsPlaying()) ||
      (playbackMode === 'manual' && engineState.playbackState === 'running')
    ) {
      animationFrameId = window.requestAnimationFrame(drawEnvelopeFrame);
    } else {
      animationFrameId = null;
    }
  };

  const syncDiagnostics = (): void => {
    const beatMapPrimary = root.querySelector<HTMLElement>('[data-role="beat-map-primary"]');
    const beatMapSecondary = root.querySelector<HTMLElement>('[data-role="beat-map-secondary"]');
    const beatMapDetails = root.querySelector<HTMLDetailsElement>('[data-role="beat-map-details"]');
    const envelopeCanvas = root.querySelector<HTMLCanvasElement>('[data-role="envelope-canvas"]');
    const metrics = root.querySelector<HTMLElement>('[data-role="metrics"]');

    const beatEntries = computeBeatMap(engineState.pairs);
    const primaryEntries = beatEntries.filter((entry) => entry.type !== 'second-order');
    const secondaryEntries = beatEntries.filter((entry) => entry.type === 'second-order');

    if (beatMapPrimary) {
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
    }

    if (beatMapSecondary) {
      beatMapSecondary.innerHTML =
        secondaryEntries.length > 0
          ? secondaryEntries
              .map((entry) =>
                renderBeatEntryRow(entry.label, entry.frequencyHz, entry.band),
              )
              .join('')
          : '<p class="subtle">No second-order interactions.</p>';
    }

    if (beatMapDetails && secondaryEntries.length === 0) {
      beatMapDetails.open = false;
    }

    if (envelopeCanvas) {
      const width = Math.max(320, Math.floor(envelopeCanvas.clientWidth || 560));
      if (envelopeCanvas.width !== width) {
        envelopeCanvas.width = width;
      }
      envelopeCanvas.height = 96;
      envelopeSamples = computeEnvelope(engineState.pairs, envelopeDurationSeconds, width);

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      drawEnvelope(envelopeCanvas, envelopeSamples, -1);
      if (
        (playbackMode === 'timeline' && timelineIsPlaying()) ||
        (playbackMode === 'manual' && engineState.playbackState === 'running')
      ) {
        animationFrameId = window.requestAnimationFrame(drawEnvelopeFrame);
      }
    }

    if (metrics) {
      const totalLayerGain = engineState.pairs.reduce((sum, pair) => sum + pair.gain, 0);
      metrics.innerHTML = [
        renderMetric('Session segments', String(session.segments.length)),
        renderMetric('Mode', playbackMode === 'timeline' ? 'Timeline' : 'Manual'),
        renderMetric('Live layers', String(engineState.pairs.length)),
        renderMetric('Master mix', formatPercent(engineState.base.masterGain)),
        renderMetric(
          'Noise bed',
          engineState.noise.enabled
            ? `${engineState.noise.model} · ${formatPercent(engineState.noise.volume)}`
            : 'Off',
        ),
        renderMetric('Layer sum', formatPercent(totalLayerGain)),
      ].join('');
    }
  };

  const renderLayout = (): void => {
    const shell = root.querySelector<HTMLElement>('.shell');
    if (shell) {
      shell.dataset.mode = playbackMode;
      shell.dataset.timelineTab =
        playbackMode === 'timeline' ? 'timeline' : 'manual';
    }

    headerShell.innerHTML =
      playbackMode === 'timeline'
        ? renderTimelineHeader(session, shareButtonLabel, playbackMode)
        : renderManualHeader(currentPresetId, shareButtonLabel, playbackMode);

    workspaceShell.innerHTML =
      playbackMode === 'timeline'
        ? renderTimelineTabWorkspace(
            session,
            timelineUI,
            carrierDisplayMode,
            composerDraft,
          )
        : renderManualWorkspace(session, timelineUI.selectedSegmentId, carrierDisplayMode);

    syncHeader();
    syncComposerOutput();
    syncGeneratedSummary();
    syncSegmentMeta();
    syncSegmentOverrides();
    syncLayerEditor(true);
    syncSupportControls(true);
    syncTimelineCanvas();
    syncAdvancedCanvas();
    syncTimelineTransport();
    syncAdvancedInspector();
    syncDiagnostics();
  };

  const syncAfterValueChange = (): void => {
    syncHeader();
    syncSegmentMeta();
    syncSegmentOverrides();
    syncLayerEditor(false);
    syncSupportControls(false);
    syncTimelineCanvas();
    syncAdvancedCanvas();
    syncTimelineTransport();
    syncGeneratedSummary();
    syncAdvancedInspector();
    syncDiagnostics();
    persistAppState();
  };

  const readComposerDraftFromDom = (): void => {
    const labelInput = root.querySelector<HTMLInputElement>('input[data-input="composer-label"]');
    const sourceInput = root.querySelector<HTMLTextAreaElement>('textarea[data-input="composer-source"]');
    const stepDurationInput = root.querySelector<HTMLInputElement>('input[data-input="composer-step-duration"]');
    const intentInput = root.querySelector<HTMLSelectElement>('select[data-input="composer-intent"]');

    composerDraft = {
      label: labelInput?.value || composerDraft.label,
      source: sourceInput?.value || composerDraft.source,
      stepDuration: Math.max(1, Number(stepDurationInput?.value ?? composerDraft.stepDuration)),
      intent: (intentInput?.value as CompositionRequest['intent']) || composerDraft.intent,
    };
  };

  const replaceSession = (
    nextSession: SessionDefinition,
    options: {
      tab?: TimelineWorkspaceTab;
      inspectorTab?: TimelineInspectorTab;
      selectedSegmentId?: string | null;
      selectedPairId?: string | null;
      selectedLaneId?: string | null;
      selectedKeyframeId?: string | null;
      analysisDockOpen?: boolean;
      analysisDockTab?: AnalysisDockTab;
      composerModalOpen?: boolean;
      preserveWorkspace?: boolean;
      preservePreset?: boolean;
      rerender?: boolean;
    } = {},
  ): void => {
    session = createSessionDefinition(nextSession);

    ensureTimelineUI(
      options.preserveWorkspace === false
        ? {
            tab: options.tab ?? 'timeline',
            inspectorTab: options.inspectorTab ?? 'segment',
            selectedSegmentId: options.selectedSegmentId ?? session.segments[0]?.id ?? null,
            selectedPairId: options.selectedPairId ?? session.segments[0]?.state.pairs[0]?.id ?? null,
            zoomLevel: timelineUI.zoomLevel,
            viewportLeft: 0,
            selectedLaneId: options.selectedLaneId ?? null,
            selectedKeyframeId: options.selectedKeyframeId ?? null,
            analysisDockOpen:
              options.analysisDockOpen ?? timelineUI.analysisDockOpen,
            analysisDockTab: options.analysisDockTab ?? timelineUI.analysisDockTab,
            advancedZoomLevel: timelineUI.advancedZoomLevel,
            advancedViewportLeft: 0,
            composerModalOpen:
              options.composerModalOpen ?? timelineUI.composerModalOpen,
          }
        : {
            tab: options.tab,
            inspectorTab: options.inspectorTab,
            selectedSegmentId: options.selectedSegmentId ?? timelineUI.selectedSegmentId,
            selectedPairId: options.selectedPairId ?? timelineUI.selectedPairId,
            selectedLaneId: options.selectedLaneId ?? timelineUI.selectedLaneId,
            selectedKeyframeId:
              options.selectedKeyframeId ?? timelineUI.selectedKeyframeId,
            analysisDockOpen:
              options.analysisDockOpen ?? timelineUI.analysisDockOpen,
            analysisDockTab:
              options.analysisDockTab ?? timelineUI.analysisDockTab,
            composerModalOpen:
              options.composerModalOpen ?? timelineUI.composerModalOpen,
          },
      session,
    );

    if (!options.preservePreset) {
      currentPresetId = null;
    }

    sequencer.replaceSession(session);

    if (activePlaybackState().status !== 'playing') {
      sequencer.seekToSegment(selectedSegmentIndex());
      syncEngineSnapshot();
    }

    if (options.rerender !== false) {
      renderLayout();
    } else {
      syncAfterValueChange();
    }
  };

  const updateSelectedSegment = (
    updater: (segment: SessionSegment) => SessionSegment,
    rerender = false,
  ): void => {
    const updatedSegments = session.segments.map((segment) =>
      segment.id === selectedSegment().id
        ? createSessionSegment(updater(segment))
        : segment,
    );

    replaceSession(
      createSessionDefinition({
        ...session,
        segments: updatedSegments,
      }),
      {
        rerender,
      },
    );
  };

  const upsertSelectedSegmentOverrideLane = (
    laneId: string,
    updater: (lane: SegmentOverrideLane) => SegmentOverrideLane,
  ): void => {
    updateSelectedSegment(
      (segment) => ({
        ...segment,
        overrides: segment.overrides.map((lane) =>
          lane.id === laneId ? updater(lane) : lane,
        ),
      }),
      true,
    );
  };

  const startManual = async (): Promise<void> => {
    applySelectedSegmentToEngine();
    engineState = await engine.start();
    syncHeader();
    syncDiagnostics();
  };

  const stopManual = async (): Promise<void> => {
    engineState = await engine.stop();
    syncHeader();
    syncDiagnostics();
  };

  sequencer.onTick(() => {
    syncEngineSnapshot();
    syncHeader();
    syncTimelineTransport();
    syncTimelinePlaybackVisuals();
    syncAdvancedPlaybackVisuals();
    syncDiagnostics();
  });

  sequencer.onSegmentChange(() => {
    syncTimelinePlaybackVisuals();
    syncAdvancedPlaybackVisuals();
    syncTimelineTransport();
    syncHeader();
  });

  sequencer.load(session);
  ensureTimelineUI(undefined, session);
  sequencer.seekToSegment(selectedSegmentIndex());
  syncEngineSnapshot();
  renderLayout();
  persistAppState();

  root.addEventListener(
    'scroll',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.dataset.role === 'timeline-scroll') {
        timelineUI = normalizeTimelineWorkspaceUIState(
          {
            ...timelineUI,
            viewportLeft: target.scrollLeft,
          },
          session,
        );
      } else if (target.dataset.role === 'advanced-scroll') {
        timelineUI = normalizeTimelineWorkspaceUIState(
          {
            ...timelineUI,
            advancedViewportLeft: target.scrollLeft,
          },
          session,
        );
      } else {
        return;
      }

      saveTimelineWorkspaceUIState(timelineUI, session);
    },
    true,
  );

  root.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      return;
    }

    const inputKey = target.dataset.input;
    if (!inputKey) {
      return;
    }

    if (inputKey.startsWith('composer-')) {
      readComposerDraftFromDom();
      persistAppState();
      return;
    }

    if (inputKey === 'session-loop') {
      replaceSession(
        createSessionDefinition({
          ...session,
          loop: target instanceof HTMLInputElement ? target.checked : session.loop,
        }),
        {
          rerender: false,
        },
      );
      return;
    }

    if (inputKey === 'noiseEnabled') {
      updateSelectedSegment(
        (segment) => ({
          ...segment,
          state: sanitizeSessionSoundState({
            ...segment.state,
            noise: {
              ...segment.state.noise,
              enabled: target instanceof HTMLInputElement ? target.checked : segment.state.noise.enabled,
            },
          }),
        }),
        false,
      );
      return;
    }

    if (inputKey === 'noiseVolume') {
      updateSelectedSegment(
        (segment) => ({
          ...segment,
          state: sanitizeSessionSoundState({
            ...segment.state,
            noise: {
              ...segment.state.noise,
              volume: Number((target as HTMLInputElement).value),
            },
          }),
        }),
        false,
      );
      return;
    }

    if (inputKey === 'masterGain') {
      updateSelectedSegment(
        (segment) => ({
          ...segment,
          state: sanitizeSessionSoundState({
            ...segment.state,
            masterGain: Number((target as HTMLInputElement).value),
          }),
        }),
        false,
      );
      return;
    }

    if (inputKey === 'segment-hold-slider' && target instanceof HTMLInputElement) {
      const nextHoldDuration = clampSegmentHold(Number(target.value));
      updateSelectedSegment(
        (segment) => ({
          ...segment,
          holdDuration: nextHoldDuration,
          transitionDuration: clampSegmentTransition(
            segment.transitionDuration,
            nextHoldDuration,
          ),
        }),
        false,
      );
      return;
    }

    if (inputKey === 'segment-transition-slider' && target instanceof HTMLInputElement) {
      updateSelectedSegment(
        (segment) => ({
          ...segment,
          transitionDuration: clampSegmentTransition(
            Number(target.value),
            segment.holdDuration,
          ),
        }),
        false,
      );
      return;
    }

    if (
      inputKey === 'segment-override-keyframe-time-slider' &&
      target instanceof HTMLInputElement
    ) {
      const maxSeconds = segmentOverrideSpanSeconds(selectedSegment());
      const nextValue = clampNumeric(Number(target.value), 0, maxSeconds);
      const editor = target.closest<HTMLElement>('.segment-override-keyframe-editor');
      const output = editor?.querySelector<HTMLOutputElement>(
        '[data-role="segment-override-keyframe-time-output"]',
      );
      if (output) {
        output.value = formatSeconds(nextValue);
      }
      return;
    }

    if (
      inputKey === 'segment-override-keyframe-value-slider' &&
      target instanceof HTMLInputElement &&
      target.dataset.target
    ) {
      const sliderTarget = target.dataset.target as SegmentOverrideTarget;
      const normalized = normalizeSegmentOverrideSliderValue(
        sliderTarget,
        Number(target.value),
        carrierDisplayMode,
      );
      if (sliderTarget.endsWith('.carrierHz') && typeof normalized === 'number') {
        target.value = String(normalized);
      }
      const editor = target.closest<HTMLElement>('.segment-override-keyframe-editor');
      const output = editor?.querySelector<HTMLOutputElement>(
        '[data-role="segment-override-keyframe-value-output"]',
      );
      if (output && typeof normalized === 'number') {
        output.value = formatSegmentOverrideValue(
          sliderTarget,
          normalized,
          carrierDisplayMode,
        );
      }
      return;
    }

    const pairId = target.dataset.pairId;
    if (pairId && inputKey !== 'carrierNote') {
      const numericValue = Number((target as HTMLInputElement).value);
      if (inputKey === 'carrierHz' || inputKey === 'beatHz' || inputKey === 'gain') {
        const nextValue =
          inputKey === 'carrierHz' &&
          target instanceof HTMLInputElement &&
          target.type === 'range' &&
          carrierDisplayMode === 'note'
            ? midiToFrequency(Number(target.value))
            : numericValue;

        updateSelectedSegment(
          (segment) => ({
            ...segment,
            state: {
              ...segment.state,
              pairs: updateTonePair(segment.state.pairs, pairId, {
                [inputKey]: nextValue,
              } as Partial<Omit<TonePair, 'id'>>),
            },
          }),
          false,
        );
      }
    }
  });

  root.addEventListener('change', async (event) => {
    const target = event.target;

    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
      return;
    }

    const inputKey = target.dataset.input;
    if (!inputKey) {
      return;
    }

    if (inputKey === 'carrierNote' && target instanceof HTMLInputElement && target.dataset.pairId) {
      const parsedFrequency = parseNoteLabel(target.value);
      if (parsedFrequency === null) {
        syncLayerEditor(true);
        return;
      }

      updateSelectedSegment(
        (segment) => ({
          ...segment,
          state: {
            ...segment.state,
            pairs: updateTonePair(segment.state.pairs, target.dataset.pairId!, {
              carrierHz: parsedFrequency,
            }),
          },
        }),
        false,
      );
      return;
    }

    if (inputKey === 'segment-label' && target instanceof HTMLInputElement) {
      updateSelectedSegment((segment) => ({
        ...segment,
        label: target.value.trim() || 'Segment',
      }), false);
      return;
    }

    if (inputKey === 'segment-hold-duration' && target instanceof HTMLInputElement) {
      const nextHoldDuration = clampSegmentHold(Number(target.value));
      updateSelectedSegment((segment) => ({
        ...segment,
        holdDuration: nextHoldDuration,
        transitionDuration: clampSegmentTransition(
          segment.transitionDuration,
          nextHoldDuration,
        ),
      }), false);
      return;
    }

    if (inputKey === 'noiseModel' && target instanceof HTMLSelectElement) {
      updateSelectedSegment((segment) => ({
        ...segment,
        state: sanitizeSessionSoundState({
          ...segment.state,
          noise: {
            ...segment.state.noise,
            model: target.value as NoiseModel,
          },
        }),
      }), false);
      return;
    }

    if (inputKey === 'manual-segment-select' && target instanceof HTMLSelectElement) {
      ensureTimelineUI({ selectedSegmentId: target.value });
      if (engineState.playbackState !== 'running') {
        applySelectedSegmentToEngine();
      }
      renderLayout();
      persistAppState();
      return;
    }

    if (inputKey === 'composer-intent') {
      readComposerDraftFromDom();
      persistAppState();
      return;
    }

    if (inputKey === 'segment-override-enabled' && target instanceof HTMLInputElement && target.dataset.laneId) {
      upsertSelectedSegmentOverrideLane(target.dataset.laneId, (lane) => ({
        ...lane,
        enabled: target.checked,
      }));
      return;
    }

    if (inputKey === 'segment-override-target' && target instanceof HTMLSelectElement && target.dataset.laneId) {
      const nextTarget = target.value as SegmentOverrideTarget;
      const baseValue = segmentStartValueForOverrideTarget(
        selectedSegment(),
        nextTarget,
      );
      upsertSelectedSegmentOverrideLane(target.dataset.laneId, (lane) => ({
        ...lane,
        target: nextTarget,
        label: describeSegmentOverrideTarget(
          selectedSegment(),
          nextTarget,
        ),
        interpolation: effectiveOverrideInterpolation(
          nextTarget,
          lane.interpolation,
        ),
        keyframes: lane.keyframes.map((keyframe) => ({
          ...keyframe,
          value: baseValue,
        })),
      }));
      return;
    }

    if (inputKey === 'segment-override-interpolation' && target instanceof HTMLSelectElement && target.dataset.laneId) {
      upsertSelectedSegmentOverrideLane(target.dataset.laneId, (lane) => ({
        ...lane,
        interpolation: effectiveOverrideInterpolation(
          lane.target,
          target.value === 'step' ? 'step' : 'linear',
        ),
      }));
      return;
    }

    if (
      (inputKey === 'segment-override-keyframe-time' ||
        inputKey === 'segment-override-keyframe-time-slider') &&
      target instanceof HTMLInputElement &&
      target.dataset.laneId &&
      target.dataset.keyframeId
    ) {
      const maxSeconds = segmentOverrideSpanSeconds(selectedSegment());
      upsertSelectedSegmentOverrideLane(target.dataset.laneId, (lane) => ({
        ...lane,
        keyframes: lane.keyframes
          .map((keyframe) =>
            keyframe.id === target.dataset.keyframeId
              ? {
                  ...keyframe,
                  time: Math.max(0, Math.min(maxSeconds, Number(target.value))),
                }
              : keyframe,
          )
          .sort((left, right) => left.time - right.time),
      }));
      return;
    }

    if (
      inputKey === 'segment-override-keyframe-value-slider' &&
      target instanceof HTMLInputElement &&
      target.dataset.laneId &&
      target.dataset.keyframeId &&
      target.dataset.target
    ) {
      const sliderTarget = target.dataset.target as SegmentOverrideTarget;
      const normalizedValue = normalizeSegmentOverrideSliderValue(
        sliderTarget,
        Number(target.value),
        carrierDisplayMode,
      );
      if (sliderTarget.endsWith('.carrierHz') && typeof normalizedValue === 'number') {
        target.value = String(normalizedValue);
      }
      upsertSelectedSegmentOverrideLane(target.dataset.laneId, (lane) => ({
        ...lane,
        keyframes: lane.keyframes.map((keyframe) =>
          keyframe.id === target.dataset.keyframeId
            ? {
                ...keyframe,
                value: normalizedValue,
              }
            : keyframe,
        ),
      }));
      return;
    }

    if (
      inputKey === 'segment-override-keyframe-value-enum' &&
      target instanceof HTMLSelectElement &&
      target.dataset.laneId &&
      target.dataset.keyframeId
    ) {
      upsertSelectedSegmentOverrideLane(target.dataset.laneId, (lane) => ({
        ...lane,
        keyframes: lane.keyframes.map((keyframe) =>
          keyframe.id === target.dataset.keyframeId
            ? {
                ...keyframe,
                value: normalizeKeyframeValue(lane.target, target.value),
              }
            : keyframe,
        ),
      }));
      return;
    }

    if (inputKey === 'lane-value' && target.dataset.laneId && target.dataset.keyframeId) {
      upsertSelectedSegmentOverrideLane(target.dataset.laneId, (lane) => ({
        ...lane,
        keyframes: lane.keyframes.map((keyframe) =>
          keyframe.id === target.dataset.keyframeId
            ? {
                ...keyframe,
                value: normalizeKeyframeValue(
                  lane.target as SegmentOverrideTarget,
                  target instanceof HTMLSelectElement ? target.value : target.value,
                ),
              }
            : keyframe,
        ),
      }));
      return;
    }
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

    if (action === 'share-link') {
      persistAppState();

      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(window.location.href);
          shareButtonLabel = 'Link copied';
        } else {
          shareButtonLabel = 'Link in address bar';
        }
      } catch {
        shareButtonLabel = 'Link ready in address bar';
      }

      syncHeader();
      if (shareFeedbackTimeoutId !== null) {
        window.clearTimeout(shareFeedbackTimeoutId);
      }

      shareFeedbackTimeoutId = window.setTimeout(() => {
        shareButtonLabel = 'Copy share link';
        syncHeader();
      }, 1800);
      return;
    }

    if (action === 'dismiss-headphone-notice') {
      headphoneNoticeVisible = false;
      markHeadphoneNoticeSeen();
      syncHeader();
      return;
    }

    if (action === 'set-playback-mode' && actionTarget.dataset.mode) {
      const nextMode = actionTarget.dataset.mode as PlaybackMode;
      if (nextMode === playbackMode) {
        return;
      }

      if (playbackMode === 'timeline') {
        await sequencer.stop();
      } else if (engineState.playbackState === 'running') {
        await stopManual();
      }

      playbackMode = nextMode;
      if (nextMode === 'timeline') {
        ensureTimelineUI(
          {
            tab: 'timeline',
            composerModalOpen: !hasExistingTimeline(session),
          },
          session,
        );
      }
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'open-composer-modal') {
      ensureTimelineUI({
        composerModalOpen: true,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'close-composer-modal') {
      ensureTimelineUI({
        composerModalOpen: false,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'composer-modal-surface') {
      return;
    }

    if (action === 'set-inspector-tab' && actionTarget.dataset.tab) {
      ensureTimelineUI({
        inspectorTab: actionTarget.dataset.tab as TimelineInspectorTab,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'set-analysis-dock-tab' && actionTarget.dataset.tab) {
      ensureTimelineUI({
        analysisDockOpen: true,
        analysisDockTab: actionTarget.dataset.tab as AnalysisDockTab,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'toggle-analysis-dock') {
      ensureTimelineUI({
        analysisDockOpen: !timelineUI.analysisDockOpen,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'set-carrier-mode' && actionTarget.dataset.mode) {
      const nextMode = actionTarget.dataset.mode as CarrierDisplayMode;
      if (nextMode !== carrierDisplayMode) {
        carrierDisplayMode = nextMode;
        renderLayout();
        persistAppState();
      }
      return;
    }

    if (action === 'manual-transport') {
      if (engineState.playbackState === 'running') {
        await stopManual();
      } else {
        await startManual();
      }
      return;
    }

    if (action === 'play-timeline') {
      await sequencer.play();
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'pause-timeline') {
      await sequencer.pause();
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'resume-timeline') {
      await sequencer.resume();
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'stop-timeline') {
      await sequencer.stop();
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'jump-selected') {
      sequencer.seekToSegment(selectedSegmentIndex());
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'select-segment-override-lane' && actionTarget.dataset.laneId) {
      const lane = selectedSegment().overrides.find(
        (item) => item.id === actionTarget.dataset.laneId,
      );
      ensureTimelineUI({
        selectedLaneId: actionTarget.dataset.laneId,
        selectedKeyframeId: lane?.keyframes[0]?.id ?? null,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (
      action === 'select-segment-override-keyframe' &&
      actionTarget.dataset.laneId &&
      actionTarget.dataset.keyframeId
    ) {
      ensureTimelineUI({
        selectedLaneId: actionTarget.dataset.laneId,
        selectedKeyframeId: actionTarget.dataset.keyframeId,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (
      action === 'set-segment-override-interpolation' &&
      actionTarget.dataset.laneId &&
      actionTarget.dataset.value
    ) {
      upsertSelectedSegmentOverrideLane(actionTarget.dataset.laneId, (lane) => ({
        ...lane,
        interpolation: effectiveOverrideInterpolation(
          lane.target,
          actionTarget.dataset.value === 'step' ? 'step' : 'linear',
        ),
      }));
      return;
    }

    if (
      action === 'set-segment-override-keyframe-boolean' &&
      actionTarget.dataset.laneId &&
      actionTarget.dataset.keyframeId &&
      actionTarget.dataset.value
    ) {
      const nextValue = actionTarget.dataset.value;
      upsertSelectedSegmentOverrideLane(actionTarget.dataset.laneId, (lane) => ({
        ...lane,
        keyframes: lane.keyframes.map((keyframe) =>
          keyframe.id === actionTarget.dataset.keyframeId
            ? {
                ...keyframe,
                value: normalizeKeyframeValue(
                  lane.target,
                  nextValue,
                ),
              }
            : keyframe,
        ),
      }));
      return;
    }

    if (action === 'timeline-zoom-in') {
      ensureTimelineUI({
        zoomLevel: Math.min(
          TIMELINE_ZOOM.max,
          timelineUI.zoomLevel + TIMELINE_ZOOM.step,
        ),
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'advanced-zoom-in') {
      ensureTimelineUI({
        advancedZoomLevel: Math.min(
          TIMELINE_ZOOM.max,
          timelineUI.advancedZoomLevel + TIMELINE_ZOOM.step,
        ),
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'advanced-zoom-out') {
      ensureTimelineUI({
        advancedZoomLevel: Math.max(
          TIMELINE_ZOOM.min,
          timelineUI.advancedZoomLevel - TIMELINE_ZOOM.step,
        ),
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'advanced-fit') {
      const scrollContainer = root.querySelector<HTMLElement>('[data-role="advanced-scroll"]');
      const availableWidth = scrollContainer?.clientWidth ?? 0;
      const currentWidth = buildAdvancedViewportModel(
        session,
        activePlaybackState(),
        timelineUI.advancedZoomLevel,
      ).contentWidth;

      if (!scrollContainer || availableWidth <= 0 || currentWidth <= availableWidth + 1) {
        return;
      }

      ensureTimelineUI({
        advancedZoomLevel: findAdvancedFitZoom(session, availableWidth),
        advancedViewportLeft: 0,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'timeline-zoom-out') {
      ensureTimelineUI({
        zoomLevel: Math.max(
          TIMELINE_ZOOM.min,
          timelineUI.zoomLevel - TIMELINE_ZOOM.step,
        ),
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'timeline-fit') {
      const scrollContainer = root.querySelector<HTMLElement>('[data-role="timeline-scroll"]');
      const availableWidth = scrollContainer?.clientWidth ?? 0;
      const currentWidth = buildTimelineViewportModel(
        session,
        activePlaybackState(),
        timelineUI.zoomLevel,
      ).contentWidth;

      if (!scrollContainer || availableWidth <= 0 || currentWidth <= availableWidth + 1) {
        return;
      }

      const fitZoom = findFitZoom(session, availableWidth);

      ensureTimelineUI({
        zoomLevel: fitZoom,
        viewportLeft: 0,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'generate-session') {
      readComposerDraftFromDom();

      try {
        const plan = generateSessionPlan(composerDraftToRequest(composerDraft));
        composerExplanation = plan.explanation;
        playbackMode = 'timeline';
        replaceSession(plan.session, {
          preserveWorkspace: false,
          tab: 'timeline',
          inspectorTab: 'segment',
          selectedSegmentId: plan.session.segments[0]?.id ?? null,
          selectedPairId: plan.session.segments[0]?.state.pairs[0]?.id ?? null,
          composerModalOpen: false,
          preservePreset: false,
        });
      } catch (error) {
        composerExplanation = [
          error instanceof Error
            ? error.message
            : 'Could not generate a timeline from that input yet.',
        ];
        syncComposerOutput();
      }
      persistAppState();
      return;
    }

    if (action === 'select-segment' && actionTarget.dataset.segmentId) {
      ensureTimelineUI({
        selectedSegmentId: actionTarget.dataset.segmentId,
      });
      if (activePlaybackState().status !== 'playing' && engineState.playbackState !== 'running') {
        applySelectedSegmentToEngine();
      }
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'select-pair' && actionTarget.dataset.pairId) {
      ensureTimelineUI({
        inspectorTab: 'layers',
        selectedPairId: actionTarget.dataset.pairId,
      });
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'seek-segment' && actionTarget.dataset.segmentId) {
      ensureTimelineUI({
        selectedSegmentId: actionTarget.dataset.segmentId,
      });
      sequencer.seekToSegment(selectedSegmentIndex());
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'add-segment-after' && actionTarget.dataset.segmentId) {
      const index = session.segments.findIndex((segment) => segment.id === actionTarget.dataset.segmentId);
      if (index === -1) {
        return;
      }

      const baseSegment = session.segments[index]!;
      const nextSegment = createSessionSegment({
        label: `${baseSegment.label || 'Segment'} copy`,
        holdDuration: baseSegment.holdDuration,
        transitionDuration: baseSegment.transitionDuration || 4,
        state: sanitizeSessionSoundState(baseSegment.state),
      });
      const segments = [...session.segments];
      segments.splice(index + 1, 0, nextSegment);
      replaceSession(
        createSessionDefinition({
          ...session,
          segments,
        }),
        {
          selectedSegmentId: nextSegment.id,
        },
      );
      return;
    }

    if (action === 'duplicate-segment' && actionTarget.dataset.segmentId) {
      const index = session.segments.findIndex((segment) => segment.id === actionTarget.dataset.segmentId);
      if (index === -1) {
        return;
      }
      const sourceSegment = session.segments[index]!;
      const nextSegment = createSessionSegment({
        label: `${sourceSegment.label || 'Segment'} copy`,
        holdDuration: sourceSegment.holdDuration,
        transitionDuration: sourceSegment.transitionDuration,
        state: sanitizeSessionSoundState(sourceSegment.state),
      });
      const segments = [...session.segments];
      segments.splice(index + 1, 0, nextSegment);
      replaceSession(
        createSessionDefinition({
          ...session,
          segments,
        }),
        {
          selectedSegmentId: nextSegment.id,
        },
      );
      return;
    }

    if (action === 'remove-segment' && actionTarget.dataset.segmentId && session.segments.length > 1) {
      const remaining = session.segments.filter((segment) => segment.id !== actionTarget.dataset.segmentId);
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: remaining,
        }),
        {
          selectedSegmentId:
            timelineUI.selectedSegmentId === actionTarget.dataset.segmentId
              ? remaining[0]?.id ?? null
              : timelineUI.selectedSegmentId,
        },
      );
      return;
    }

    if (action === 'add-pair') {
      const { pair, pairs } = addTonePair(selectedState().pairs, {
        carrierHz: 200,
        beatHz: 10,
        gain: 0.75,
      });
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: session.segments.map((segment) =>
            segment.id === selectedSegment().id
              ? createSessionSegment({
                  ...segment,
                  state: sanitizeSessionSoundState({
                    ...segment.state,
                    pairs,
                  }),
                })
              : segment,
          ),
        }),
        {
          selectedPairId: pair.id,
          inspectorTab: 'layers',
        },
      );
      return;
    }

    if (action === 'remove-pair' && actionTarget.dataset.pairId) {
      const nextPairs = removeTonePair(
        selectedState().pairs,
        actionTarget.dataset.pairId,
      );
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: session.segments.map((segment) =>
            segment.id === selectedSegment().id
              ? createSessionSegment({
                  ...segment,
                  state: sanitizeSessionSoundState({
                    ...segment.state,
                    pairs: nextPairs,
                  }),
                })
              : segment,
          ),
        }),
        {
          selectedPairId:
            timelineUI.selectedPairId === actionTarget.dataset.pairId
              ? nextPairs[0]?.id ?? null
              : timelineUI.selectedPairId,
          inspectorTab: 'layers',
        },
      );
      return;
    }

    if (action === 'add-segment-override-lane') {
      const selected = selectedSegment();
      const targets = collectSegmentOverrideTargets(selected);
      const defaultTarget = targets[0] ?? 'masterGain';
      const startValue = segmentStartValueForOverrideTarget(
        selected,
        defaultTarget,
      );
      const lane: SegmentOverrideLane = {
        id: `override-${Math.random().toString(36).slice(2, 8)}`,
        label: describeSegmentOverrideTarget(selected, defaultTarget),
        target: defaultTarget,
        interpolation: effectiveOverrideInterpolation(defaultTarget, 'linear'),
        enabled: true,
        keyframes: [
          {
            id: `keyframe-${Math.random().toString(36).slice(2, 8)}`,
            time: 0,
            value: startValue,
          },
        ],
      };

      replaceSession(
        createSessionDefinition({
          ...session,
          segments: session.segments.map((segment) =>
            segment.id === selected.id
              ? createSessionSegment({
                  ...segment,
                  overrides: [...segment.overrides, lane],
                })
              : segment,
          ),
        }),
        {
          selectedLaneId: lane.id,
          selectedKeyframeId: lane.keyframes[0]?.id ?? null,
        },
      );
      return;
    }

    if (action === 'remove-segment-override-lane' && actionTarget.dataset.laneId) {
      const selected = selectedSegment();
      const remainingOverrides = selected.overrides.filter(
        (lane) => lane.id !== actionTarget.dataset.laneId,
      );
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: session.segments.map((segment) =>
            segment.id === selected.id
              ? createSessionSegment({
                  ...segment,
                  overrides: remainingOverrides,
                })
              : segment,
          ),
        }),
        {
          selectedLaneId:
            timelineUI.selectedLaneId === actionTarget.dataset.laneId
              ? remainingOverrides[0]?.id ?? null
              : timelineUI.selectedLaneId,
          selectedKeyframeId:
            timelineUI.selectedLaneId === actionTarget.dataset.laneId
              ? remainingOverrides[0]?.keyframes[0]?.id ?? null
              : timelineUI.selectedKeyframeId,
        },
      );
      return;
    }

    if (action === 'add-segment-override-keyframe' && actionTarget.dataset.laneId) {
      const selected = selectedSegment();
      const timelineDuration = segmentOverrideSpanSeconds(selected);
      const keyframeId = `keyframe-${Math.random().toString(36).slice(2, 8)}`;
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: session.segments.map((segment) =>
            segment.id === selected.id
              ? createSessionSegment({
                  ...segment,
                  overrides: segment.overrides.map((lane) =>
                    lane.id === actionTarget.dataset.laneId
                      ? {
                          ...lane,
                          keyframes: [
                            ...lane.keyframes,
                          {
                              id: keyframeId,
                              time: timelineDuration,
                              value: segmentStartValueForOverrideTarget(
                                selected,
                                lane.target as SegmentOverrideTarget,
                              ),
                            },
                          ].sort((left, right) => left.time - right.time),
                        }
                      : lane,
                  ),
                })
              : segment,
          ),
        }),
        {
          selectedLaneId: actionTarget.dataset.laneId,
          selectedKeyframeId: keyframeId,
        },
      );
      return;
    }

    if (action === 'remove-segment-override-keyframe' && actionTarget.dataset.laneId && actionTarget.dataset.keyframeId) {
      const lane = selectedSegment().overrides.find(
        (item) => item.id === actionTarget.dataset.laneId,
      );
      const nextKeyframes =
        lane && lane.keyframes.length > 1
          ? lane.keyframes.filter(
              (keyframe) => keyframe.id !== actionTarget.dataset.keyframeId,
            )
          : lane?.keyframes ?? [];
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: session.segments.map((segment) =>
            segment.id === selectedSegment().id
              ? createSessionSegment({
                  ...segment,
                  overrides: segment.overrides.map((item) =>
                    item.id === actionTarget.dataset.laneId
                      ? {
                          ...item,
                          keyframes: nextKeyframes,
                        }
                      : item,
                  ),
                })
              : segment,
          ),
        }),
        {
          selectedLaneId: actionTarget.dataset.laneId,
          selectedKeyframeId:
            timelineUI.selectedKeyframeId === actionTarget.dataset.keyframeId
              ? nextKeyframes[0]?.id ?? null
              : timelineUI.selectedKeyframeId,
        },
      );
    }
  });

  root.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.role !== 'preset-select') {
      return;
    }

    if (target.value === 'custom') {
      currentPresetId = null;
      syncHeader();
      persistAppState();
      return;
    }

    const preset = getPresetById(target.value);
    if (!preset) {
      return;
    }

    currentPresetId = preset.id;
    session = preset.state.session;
    composerDraft = preset.state.composer;
    playbackMode = preset.state.mode;
    composerExplanation = [];
    sequencer.load(session);
    ensureTimelineUI(
      {
        tab: 'timeline',
        inspectorTab: 'segment',
        selectedSegmentId: session.segments[0]?.id ?? null,
        selectedPairId: session.segments[0]?.state.pairs[0]?.id ?? null,
        composerModalOpen: !hasExistingTimeline(session),
      },
      session,
    );
    sequencer.seekToSegment(selectedSegmentIndex());
    syncEngineSnapshot();
    renderLayout();
    persistAppState();
  });

  window.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      playbackMode === 'timeline' &&
      timelineUI.composerModalOpen
    ) {
      ensureTimelineUI({
        composerModalOpen: false,
      });
      renderLayout();
      persistAppState();
    }
  });

  window.addEventListener('resize', () => {
    syncDiagnostics();
  });
}
