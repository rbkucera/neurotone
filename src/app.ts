import {
  BinauralEngine,
  addTonePair,
  computeTonePairSnapshot,
  removeTonePair,
  sanitizeTonePair,
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
  decodeInitialViewHintFromHash,
  decodeShareableState,
  encodeShareableState,
  hasSeenHeadphoneNotice,
  hasSeenHighVolumeWarning,
  loadMasterVolume,
  loadStoredStateViewHint,
  loadStoredState,
  markHeadphoneNoticeSeen,
  markHighVolumeWarningSeen,
  saveMasterVolume,
  saveStoredState,
  loadSavedSessions,
  saveSessionToLibrary,
  updateSavedSession,
  deleteSavedSession,
  exportSavedSessions,
  importSavedSessions,
  loadTheme,
  saveTheme,
  type ComposerDraft,
  type PlaybackMode,
  type SavedSession,
  type ThemeId,
  type ShareableState,
} from './sessionState';
import { catalog, getCatalogEntry, type CatalogEntry } from './catalog';
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
import {
  DEFAULT_VISUALIZER_ID,
  PixiVisualizerRuntime,
  bandOrder,
  VISUALIZER_REGISTRY,
} from './visualizers/registry';
import {
  advanceBandActivity,
  createEmptyBandActivity,
  type VisualizerBand,
  type VisualizerBandActivity,
} from './visualizers/bands';
import {
  computeSyntheticStft,
  sampleLogBands,
  synthesizeStereoSignal,
} from './visualizers/signal';

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

const TIMELINE_CHIP_ACTIONS = {
  inlineMinWidthPx: 138,
  confirmInlineMinWidthPx: 204,
  overlayMinWidthPx: 124,
};

const TIMELINE_COLLAPSED_THRESHOLD_PX = 48;
const TIMELINE_COLLAPSED_WIDTH_PX = 36;

const TIMELINE_ZOOM = {
  min: 0.1,
  max: 3,
  step: 0.1,
  default: 1,
};

const VISUALIZER_PIXI_INIT_TIMEOUT_MS = 2400;

const ADVANCED_LAYOUT = {
  labelWidthPx: 118,
  rulerHeightPx: 32,
  segmentStripHeightPx: 42,
  laneRowHeightPx: 42,
  laneGapPx: 10,
};

type TimelineDragInsertPosition = 'before' | 'after';
type AppViewMode = PlaybackMode | 'analysis' | 'catalog';
type VisualizerRendererMode = 'pixi-webgl' | 'compatibility';

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
        class="segmented-control__button ${currentMode === 'timeline' ? 'is-active' : ''}"
        data-action="set-playback-mode"
        data-mode="timeline"
        type="button"
      >
        Timeline
      </button>
      <button
        class="segmented-control__button ${currentMode === 'visualizer' ? 'is-active' : ''}"
        data-action="set-playback-mode"
        data-mode="visualizer"
        type="button"
      >
        Visualizer
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

function renderSupportControls(noise: NoiseConfig, segmentGain: number): string {
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
          <span>Segment gain</span>
          <output data-role="segment-gain-output">${formatPercent(segmentGain)}</output>
        </div>
        <input
          data-input="segmentGain"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value="${segmentGain}"
        />
      </label>
    </section>
  `;
}

function describeAutomationTarget(target: AutomationTarget): string {
  if (target === 'gain') {
    return 'Segment gain';
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
    'gain',
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

  if (target === 'gain') {
    return { kind: 'numeric', min: 0, max: 1, step: 0.01 };
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
    lane.target === 'gain' || lane.target === 'noise.volume'
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
  if (target === 'gain') {
    return 'Gain';
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
  collapsed: boolean;
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
  segmentLoopOnly = false,
  selectedSegmentId: string | null = null,
): TimelineViewportModel {
  const windows = buildSegmentWindows(session);
  const totalDuration = totalSessionDuration(session);
  const nextPixelsPerSecond = pixelsPerSecond(zoomLevel);

  const clips = windows.map((window) => {
    const trueWidth = Math.max(1, segmentSpanDuration(window) * nextPixelsPerSecond);
    const clip: TimelineClipModel = {
      window,
      left: window.transitionStart * nextPixelsPerSecond,
      width: trueWidth,
      collapsed: trueWidth < TIMELINE_COLLAPSED_THRESHOLD_PX,
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
  const selectedWindow =
    segmentLoopOnly && selectedSegmentId
      ? windows.find((window) => window.segment.id === selectedSegmentId) ?? null
      : null;
  const selectedWindowSpan = selectedWindow
    ? segmentSpanDuration(selectedWindow)
    : 0;
  const loopSelectedElapsed =
    selectedWindow && selectedWindowSpan > 0
      ? ((playbackState.totalElapsed % selectedWindowSpan) + selectedWindowSpan) %
        selectedWindowSpan
      : playbackState.totalElapsed;
  const globalElapsedSeconds = selectedWindow
    ? selectedWindow.transitionStart + loopSelectedElapsed
    : playbackState.totalElapsed;
  const globalPlayheadX = Math.max(0, Math.min(globalElapsedSeconds, totalDuration)) *
    nextPixelsPerSecond;

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
  segmentLoopOnly = false,
  selectedSegmentId: string | null = null,
): number {
  if (
    segmentLoopOnly &&
    selectedSegmentId &&
    playbackState.status !== 'complete'
  ) {
    if (clip.window.segment.id !== selectedSegmentId) {
      return 0;
    }
    const span = segmentSpanDuration(clip.window);
    if (span <= 0) {
      return 0;
    }
    const elapsed = ((playbackState.totalElapsed % span) + span) % span;
    return Math.min(1, Math.max(0, elapsed / span));
  }

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

function renderTimelineChipActions(
  segmentId: string,
  canRemove: boolean,
  variant: 'inline' | 'overlay',
  pendingRemoveSegmentId: string | null,
): string {
  if (segmentId === pendingRemoveSegmentId) {
    return `
      <div class="timeline-chip-actions timeline-chip-actions--${variant} timeline-chip-actions--confirm">
        <span class="timeline-chip-actions__confirm-label">Remove?</span>
        <button
          class="timeline-chip-action timeline-chip-action--confirm"
          data-action="confirm-remove-segment"
          data-segment-id="${segmentId}"
          type="button"
          aria-label="Confirm remove segment"
        >
          Yes
        </button>
        <button
          class="timeline-chip-action"
          data-action="cancel-remove-segment"
          data-segment-id="${segmentId}"
          type="button"
          aria-label="Cancel remove segment"
        >
          No
        </button>
      </div>
    `;
  }

  return `
    <div class="timeline-chip-actions timeline-chip-actions--${variant}">
      <button
        class="timeline-chip-action"
        data-action="seek-segment"
        data-segment-id="${segmentId}"
        type="button"
        title="Jump to segment"
        aria-label="Jump to segment"
      >
        J
      </button>
      <button
        class="timeline-chip-action"
        data-action="add-segment-after"
        data-segment-id="${segmentId}"
        type="button"
        title="Add segment after"
        aria-label="Add segment after"
      >
        +
      </button>
      <button
        class="timeline-chip-action"
        data-action="duplicate-segment"
        data-segment-id="${segmentId}"
        type="button"
        title="Duplicate segment"
        aria-label="Duplicate segment"
      >
        D
      </button>
      <button
        class="timeline-chip-action timeline-chip-action--danger"
        data-action="request-remove-segment"
        data-segment-id="${segmentId}"
        type="button"
        title="Remove segment"
        aria-label="Remove segment"
        ${canRemove ? '' : 'disabled'}
      >
        -
      </button>
    </div>
  `;
}

function renderSegmentLaneOverlay(
  clip: TimelineClipModel,
): string {
  const customLanes = clip.window.segment.overrides.filter((lane) => lane.enabled);
  const spanSeconds = segmentSpanDuration(clip.window);

  if (customLanes.length === 0) {
    return '';
  }

  return customLanes
    .map((lane) => {
      const markers = lane.keyframes
        .filter(
          (keyframe) =>
            keyframe.time >= 0 &&
            keyframe.time <= spanSeconds + 0.0001,
        )
        .map((keyframe) => {
          const left = (keyframe.time / spanSeconds) * 100;

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
  segmentLoopOnly: boolean,
  revealedChipActionsSegmentId: string | null,
  pendingRemoveSegmentId: string | null,
  dragEnabled: boolean,
): string {
  const viewport = buildTimelineViewportModel(
    session,
    playbackState,
    zoomLevel,
    segmentLoopOnly,
    selectedSegmentId,
  );
  const canRemoveSegment = session.segments.length > 1;
  const overlayCandidateId = revealedChipActionsSegmentId ?? selectedSegmentId;
  const overlayCandidateClip = overlayCandidateId
    ? viewport.clips.find((clip) => clip.window.segment.id === overlayCandidateId)
    : undefined;
  const overlayCandidateMinWidth =
    overlayCandidateId === pendingRemoveSegmentId
      ? TIMELINE_CHIP_ACTIONS.confirmInlineMinWidthPx
      : TIMELINE_CHIP_ACTIONS.inlineMinWidthPx;
  const overlaySegmentId =
    overlayCandidateClip &&
    overlayCandidateClip.width < overlayCandidateMinWidth
      ? overlayCandidateClip.window.segment.id
      : null;

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
        <div class="timeline-clip-track" data-role="timeline-clip-track" data-action="clear-segment-selection">
          ${viewport.clips
            .map((clip, index) => {
              const segment = clip.window.segment;
              const isSelected = segment.id === selectedSegmentId;
              const isActive = index === playbackState.currentSegmentIndex;
              const progress = computeClipProgress(
                clip,
                playbackState,
                segmentLoopOnly,
                selectedSegmentId,
              );
              const isRevealed = segment.id === revealedChipActionsSegmentId;
              const isPendingRemove = segment.id === pendingRemoveSegmentId;
              const inlineActionsThreshold = isPendingRemove
                ? TIMELINE_CHIP_ACTIONS.confirmInlineMinWidthPx
                : TIMELINE_CHIP_ACTIONS.inlineMinWidthPx;
              const hasInlineActions =
                clip.width >= inlineActionsThreshold;

              if (clip.collapsed) {
                const midpoint = clip.left + clip.width / 2;
                const collapsedLeft = midpoint - TIMELINE_COLLAPSED_WIDTH_PX / 2;
                const clipTitle = `${escapeHtml(segment.label || `Segment ${index + 1}`)} · ${formatSeconds(segmentSpanDuration(clip.window))}`;

                return `
                  <article
                    class="timeline-clip timeline-clip--collapsed ${isSelected ? 'is-selected' : ''} ${isActive ? 'is-active' : ''}"
                    data-clip-id="${segment.id}"
                    style="left:${collapsedLeft}px;width:${TIMELINE_COLLAPSED_WIDTH_PX}px"
                    title="${clipTitle}"
                  >
                    <button
                      class="timeline-clip__button"
                      data-action="select-segment"
                      data-segment-id="${segment.id}"
                      type="button"
                      draggable="${dragEnabled ? 'true' : 'false'}"
                      aria-label="${clipTitle}"
                    >
                      <span
                        class="timeline-clip__selected-led ${isSelected ? 'is-on' : ''}"
                        aria-hidden="true"
                      ></span>
                      <span class="timeline-clip__index">${index + 1}</span>
                    </button>
                  </article>
                `;
              }

              return `
                <article
                  class="timeline-clip ${isSelected ? 'is-selected' : ''} ${isActive ? 'is-active' : ''} ${isRevealed ? 'is-revealed' : ''}"
                  data-clip-id="${segment.id}"
                  style="left:${clip.left}px;width:${clip.width}px"
                >
                  <button
                    class="timeline-clip__button"
                    data-action="select-segment"
                    data-segment-id="${segment.id}"
                    type="button"
                    draggable="${dragEnabled ? 'true' : 'false'}"
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
                  ${
                    hasInlineActions
                      ? `
                        <div class="timeline-clip__actions-inline">
                          ${renderTimelineChipActions(segment.id, canRemoveSegment, 'inline', pendingRemoveSegmentId)}
                        </div>
                      `
                      : ''
                  }
                </article>
              `;
            })
            .join('')}
        </div>
      </div>
      ${
        overlaySegmentId
          ? `
            <div class="timeline-chip-overlay-layer" data-role="timeline-chip-overlay-layer" aria-hidden="true">
              <div
                class="timeline-chip-overlay"
                data-role="timeline-chip-overlay"
                data-segment-id="${overlaySegmentId}"
              >
                ${renderTimelineChipActions(overlaySegmentId, canRemoveSegment, 'overlay', pendingRemoveSegmentId)}
              </div>
            </div>
          `
          : ''
      }
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
    (target === 'gain' || target === 'noise.volume' || target.endsWith('.gain')) &&
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

type ManualDiagnosticsTab = AnalysisDockTab;

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

function renderManualDiagnosticsTabToggle(currentTab: ManualDiagnosticsTab): string {
  return `
    <div class="segmented-control segmented-control--compact">
      <button
        class="segmented-control__button ${currentTab === 'beat-map' ? 'is-active' : ''}"
        data-action="set-manual-diagnostics-tab"
        data-tab="beat-map"
        type="button"
      >
        Beat map
      </button>
      <button
        class="segmented-control__button ${currentTab === 'envelope' ? 'is-active' : ''}"
        data-action="set-manual-diagnostics-tab"
        data-tab="envelope"
        type="button"
      >
        Envelope
      </button>
      <button
        class="segmented-control__button ${currentTab === 'metrics' ? 'is-active' : ''}"
        data-action="set-manual-diagnostics-tab"
        data-tab="metrics"
        type="button"
      >
        Metrics
      </button>
    </div>
  `;
}

function renderManualDiagnosticsMarkup(
  currentTab: ManualDiagnosticsTab,
  open: boolean,
): string {
  return `
    <div class="manual-diagnostics__header">
      <div>
        <p class="layer-card__eyebrow">Diagnostics</p>
        <h3>Playback analysis</h3>
      </div>
      <div class="manual-diagnostics__header-actions">
        ${
          open
            ? renderManualDiagnosticsTabToggle(currentTab)
            : ''
        }
        <button
          class="ghost-button ghost-button--compact"
          data-action="toggle-manual-diagnostics"
          type="button"
        >
          ${open ? 'Hide diagnostics' : 'Show diagnostics'}
        </button>
      </div>
    </div>

    <div class="manual-diagnostics__body ${open ? 'is-open' : 'is-collapsed'}">
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

      <section class="analysis-pane ${currentTab === 'metrics' ? 'is-active' : ''}">
        <section class="metrics-block metrics-block--dock">
          <div class="panel__header panel__header--compact">
            <h3>Validation readout</h3>
            <span class="subtle">Live engine snapshot</span>
          </div>
          <div class="metrics" data-role="metrics"></div>
        </section>
      </section>
    </div>
  `;
}

function renderThemeToggle(theme: ThemeId): string {
  const icon = theme === 'dark' ? '&#x2600;' : '&#x263E;';
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  return `<button class="theme-toggle" data-action="cycle-theme" type="button" aria-label="${label}" title="${label}">${icon}</button>`;
}

function renderHeaderVolumeSlider(masterVolume: number, theme: ThemeId): string {
  return `
    <label class="tool-header__volume">
      <input
        data-input="masterVolume"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value="${masterVolume}"
      />
      <output data-role="master-output">${formatPercent(masterVolume)}</output>
    </label>
    ${renderThemeToggle(theme)}
  `;
}

function renderAnalysisHeader(
  session: SessionDefinition,
  shareButtonLabel: string,
  masterVolume: number,
  theme: ThemeId,
): string {
  return `
    <section class="panel panel--tool-header panel--tool-header-timeline">
      <button class="tool-header__share" data-action="share-link" type="button">
        <span data-role="share-label">${shareButtonLabel}</span>
      </button>
      <div class="tool-header tool-header--timeline">
        <div class="tool-header__row">
          <div class="session-switcher" data-role="session-switcher">
            <button class="session-switcher__trigger" data-action="toggle-session-menu" type="button">
              <h2 class="tool-header__title">${escapeHtml(session.label)}</h2>
              <span class="session-switcher__chevron" aria-hidden="true">&#x25BE;</span>
            </button>
            <div class="session-menu" data-role="session-menu" hidden></div>
          </div>

          <div class="tool-header__controls">
            <button class="transport transport--compact" data-action="return-to-timeline" type="button">
              Return to timeline
            </button>

            ${renderHeaderVolumeSlider(masterVolume, theme)}
          </div>
        </div>
      </div>
      <div data-role="headphone-notice"></div>
      <div data-role="high-volume-warning"></div>
    </section>
  `;
}

function renderTimelineHeader(
  session: SessionDefinition,
  shareButtonLabel: string,
  playbackMode: PlaybackMode,
  masterVolume: number,
  theme: ThemeId,
): string {
  return `
    <section class="panel panel--tool-header panel--tool-header-timeline">
      <button class="tool-header__share" data-action="share-link" type="button">
        <span data-role="share-label">${shareButtonLabel}</span>
      </button>
      <div class="tool-header tool-header--timeline">
        <div class="tool-header__row">
          <div class="session-switcher" data-role="session-switcher">
            <button class="session-switcher__trigger" data-action="toggle-session-menu" type="button">
              <h2 class="tool-header__title">${escapeHtml(session.label)}</h2>
              <span class="session-switcher__chevron" aria-hidden="true">&#x25BE;</span>
            </button>
            <div class="session-menu" data-role="session-menu" hidden></div>
          </div>

          <div class="tool-header__controls">
            <label class="tool-header__mode">
              ${renderPlaybackModeToggle(playbackMode)}
            </label>

            ${renderHeaderVolumeSlider(masterVolume, theme)}
          </div>
        </div>
      </div>
      <div data-role="headphone-notice"></div>
      <div data-role="high-volume-warning"></div>
    </section>
  `;
}

function renderCatalogHeader(theme: ThemeId, hasActiveSession: boolean): string {
  return `
    <section class="panel panel--tool-header panel--tool-header-timeline">
      <div class="tool-header tool-header--timeline">
        <div class="tool-header__row">
          <h2 class="tool-header__title">Neurotone</h2>
          <div class="tool-header__controls">
            ${hasActiveSession ? '<button class="ghost-button" data-action="return-to-session" type="button">Back to session</button>' : ''}
            ${renderThemeToggle(theme)}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderCatalogWorkspace(
  savedSessions: SavedSession[],
): string {
  return `
    <section class="panel panel--workspace panel--catalog">
      <div class="catalog-header">
        <h2>Sessions</h2>
        <p class="catalog-header__subtitle">Choose a session to begin, or load a saved session.</p>
      </div>

      <h3 class="catalog-section__heading">Curated</h3>
      <div class="catalog-grid">
        <button class="catalog-card catalog-card--create-new" data-action="create-new-session" type="button">
          <h3 class="catalog-card__title">+ Create new session</h3>
          <p class="catalog-card__description">Start from scratch with the composer</p>
        </button>
        ${catalog
          .map(
            (entry) => `
          <button class="catalog-card" data-action="select-catalog-entry" data-catalog-id="${entry.id}" type="button">
            <h3 class="catalog-card__title">${escapeHtml(entry.label)}</h3>
            <p class="catalog-card__description">${escapeHtml(entry.description)}</p>
          </button>
        `,
          )
          .join('')}
      </div>

      ${
        savedSessions.length > 0
          ? `
        <h3 class="catalog-section__heading">Saved</h3>
        <div class="catalog-grid">
          ${savedSessions
            .map(
              (saved) => `
            <div class="catalog-card catalog-card--saved">
              <button class="catalog-card__body" data-action="select-saved-session" data-saved-id="${saved.id}" type="button">
                <h3 class="catalog-card__title">${escapeHtml(saved.label)}</h3>
                <p class="catalog-card__meta">Saved ${escapeHtml(new Date(saved.savedAt).toLocaleDateString())}</p>
              </button>
              <button class="catalog-card__delete" data-action="delete-saved-session" data-saved-id="${saved.id}" type="button"
                aria-label="Delete saved session">&times;</button>
            </div>
          `,
            )
            .join('')}
        </div>
        <div class="catalog-actions">
          <button class="ghost-button ghost-button--compact" data-action="export-saved-sessions" type="button">Export saved sessions</button>
          <label class="ghost-button ghost-button--compact">
            Import
            <input data-action="import-saved-sessions" type="file" accept=".json" hidden />
          </label>
        </div>
      `
          : ''
      }
    </section>
  `;
}

function renderConfirmLoadDialog(
  label: string,
  catalogId: string | null,
  savedId: string | null,
): string {
  const actionAttr = catalogId
    ? `data-action="confirm-load-catalog" data-catalog-id="${catalogId}"`
    : `data-action="confirm-load-saved" data-saved-id="${savedId}"`;

  return `
    <div class="confirm-dialog" data-role="confirm-dialog">
      <div class="confirm-dialog__backdrop" data-action="close-confirm-dialog"></div>
      <div class="confirm-dialog__body" role="alertdialog" aria-modal="true" aria-label="Load session" tabindex="-1">
        <h3>Load &ldquo;${escapeHtml(label)}&rdquo;?</h3>
        <p>Your current session will be replaced.</p>
        <div class="confirm-dialog__actions">
          <button class="ghost-button" data-action="close-confirm-dialog" type="button">Cancel</button>
          <button class="transport transport--compact" ${actionAttr} type="button">
            Load session
          </button>
        </div>
      </div>
    </div>
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
      <section class="composer-modal__dialog" data-action="composer-modal-surface" role="dialog" aria-modal="true" aria-label="Composer" tabindex="-1">
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
  if (!selectedSegment) {
    return `
      <div class="inspector-empty-state">
        <strong>No segment selected</strong>
        <p class="subtle">Select a timeline clip to edit segment details, layers, and support controls.</p>
      </div>
    `;
  }

  if (inspectorTab === 'segment') {
    return `
      <div class="inspector-section">
        ${renderTimelineInspectorActions(
          selectedSegment.id,
          canRemoveSegment,
        )}
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
      <button class="transport transport--compact" data-action="enter-analysis-mode" data-segment-id="${selectedSegmentId}" type="button">Analysis mode</button>
      <button class="ghost-button ghost-button--compact" data-action="seek-segment" data-segment-id="${selectedSegmentId}" type="button">Jump</button>
      <button class="ghost-button ghost-button--compact" data-action="add-segment-after" data-segment-id="${selectedSegmentId}" type="button">Add after</button>
      <button class="ghost-button ghost-button--compact" data-action="duplicate-segment" data-segment-id="${selectedSegmentId}" type="button">Duplicate</button>
      <button class="ghost-button ghost-button--compact" data-action="request-remove-segment" data-segment-id="${selectedSegmentId}" type="button" ${canRemove ? '' : 'disabled'}>Remove</button>
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
    'gain',
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
  if (target === 'gain') {
    return 'Segment gain';
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
  if (target === 'gain') {
    return 'Gain';
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
  if (target === 'gain') {
    return normalizeKeyframeValue(target, segment.state.gain);
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
  segment: SessionSegment | null,
  timelineUI: TimelineWorkspaceUIState,
  carrierDisplayMode: CarrierDisplayMode,
): string {
  if (!segment) {
    return `
      <section class="segment-overrides">
        <div class="segment-overrides__header">
          <div>
            <p class="layer-card__eyebrow">Segment overrides</p>
            <h4>Selected segment lanes</h4>
          </div>
          <button class="secondary-action secondary-action--compact" data-action="add-segment-override-lane" type="button" disabled>Add lane</button>
        </div>
        <p class="subtle">No segment selected. Select a segment to create or edit override lanes.</p>
      </section>
    `;
  }

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
  const selectedSegment = session.segments.find(
    (segment) => segment.id === timelineUI.selectedSegmentId,
  );

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
              <h3 data-role="selected-segment-title">
                ${escapeHtml(selectedSegment?.label || 'No segment selected')}
              </h3>
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
  manualDiagnosticsTab: ManualDiagnosticsTab,
  manualDiagnosticsOpen: boolean,
): string {
  const selectedIndex = Math.max(
    0,
    session.segments.findIndex((segment) => segment.id === selectedSegmentId),
  );

  return `
    <section class="panel panel--workspace panel--workspace-manual">
      <div class="manual-edit-layout">
        <section class="panel--embedded panel--manual-diagnostics-row" data-role="manual-diagnostics">
          ${renderManualDiagnosticsMarkup(manualDiagnosticsTab, manualDiagnosticsOpen)}
        </section>

        <section class="panel--embedded panel--manual-editor">
          <div class="manual-editor__toolbar">
            <div class="manual-editor__tools">
              ${
                session.segments.length > 1
                  ? `
                    <label class="select-field select-field--compact">
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

              <label class="panel__tool panel__tool--compact">
                <span class="subtle">Carrier display</span>
                ${renderCarrierModeToggle(carrierDisplayMode)}
              </label>

              <button
                class="transport transport--compact manual-editor__transport"
                data-action="manual-transport"
                type="button"
              >
                Start selected segment
              </button>
            </div>
            <button class="secondary-action secondary-action--compact" data-action="add-pair">Add layer</button>
          </div>

          <div class="manual-workspace__summary">
            <p class="subtle">Auditioning segment ${selectedIndex + 1} of ${session.segments.length}. Analysis mode plays only the currently selected segment.</p>
          </div>

          <div class="manual-editor__body">
            <section class="manual-editor__section">
              <div class="manual-editor__section-header">
                <p class="layer-card__eyebrow">Segment</p>
                <h3 data-role="selected-segment-title">${escapeHtml(
                  session.segments[selectedIndex]?.label || `Segment ${selectedIndex + 1}`,
                )}</h3>
              </div>
              <div class="segment-editor__meta" data-role="segment-meta"></div>
            </section>

            <section class="manual-editor__section manual-editor__section--layers">
              <div class="manual-editor__section-header">
                <p class="layer-card__eyebrow">Layers</p>
                <h3>Mini mixer</h3>
              </div>
              <div class="stack-note" data-role="stack-note"></div>
              <div class="manual-layers-layout">
                <div class="layer-list layer-list--compact" data-role="layer-list"></div>
                <div data-role="layer-editor"></div>
              </div>
            </section>

            <section class="manual-editor__section">
              <div class="manual-editor__section-header">
                <p class="layer-card__eyebrow">Support</p>
                <h3>Noise and master</h3>
              </div>
              <div data-role="support-controls"></div>
            </section>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderVisualizerTransport(playbackState: SessionPlaybackState): string {
  const playing = playbackState.status === 'playing';

  return `
    <div class="transport-row__line transport-row__line--controls">
      <div class="transport-row__cluster transport-row__cluster--primary">
        <span class="transport-row__label">Visualizer</span>
        <button class="transport transport--compact" data-action="visualizer-play" type="button" ${playing ? 'disabled' : ''}>Play</button>
        <button class="ghost-button ghost-button--compact" data-action="visualizer-pause" type="button" ${playing ? '' : 'disabled'}>Pause</button>
      </div>
    </div>
    <div class="transport-row__line transport-row__line--status">
      <div class="transport-row__readout" data-role="visualizer-readout"></div>
    </div>
  `;
}

function renderVisualizerBandLeds(
  bandActivity: VisualizerBandActivity,
): string {
  return `
    <div class="visualizer-band-leds" data-role="visualizer-band-leds">
      ${bandOrder()
        .map(
          (band) => `
            <span
              class="visualizer-band-led ${bandActivity.activeBands.includes(band) ? 'is-active' : ''} ${bandActivity.dominant === band ? 'is-dominant' : ''}"
              data-band="${band}"
              title="${band.toUpperCase()}"
              aria-label="${band} band"
            >
              <span class="visualizer-band-led__dot"></span>
              <span class="visualizer-band-led__label">${band}</span>
            </span>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderVisualizerWorkspace(
  visualizerId: string,
  bandActivity: VisualizerBandActivity,
): string {

  return `
    <section class="panel panel--workspace panel--workspace-visualizer">
      <section class="transport-row" data-role="visualizer-transport"></section>

      <section class="panel--embedded panel--visualizer-surface">
        <div class="visualizer-surface__header">
          <div>
            <p class="layer-card__eyebrow">Visualizer</p>
            <h3>Playback view</h3>
          </div>
          <div class="visualizer-surface__controls">
            <div class="visualizer-renderer-status" data-role="visualizer-renderer-status">
              Renderer: Pixi
            </div>

            ${renderVisualizerBandLeds(bandActivity)}

            <label class="select-field select-field--compact visualizer-surface__select">
              <span>Style</span>
              <select data-input="visualizer-module">
                ${VISUALIZER_REGISTRY.map(
                  (module) => `
                    <option value="${module.id}" ${
                      module.id === visualizerId ? 'selected' : ''
                    }>
                      ${escapeHtml(module.label)}
                    </option>
                  `,
                ).join('')}
              </select>
            </label>
          </div>
        </div>

        <canvas class="visualizer-canvas" data-role="visualizer-canvas" height="280" aria-label="Audio visualizer"></canvas>
      </section>
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
  selectedSegmentId: string | null,
  segmentLoopOnly: boolean,
): string {
  const playing = playbackState.status === 'playing';
  const paused = playbackState.status === 'paused';
  const idle = playbackState.status === 'idle';
  const hasSelection = Boolean(selectedSegmentId);

  return `
    <div class="transport-row__line transport-row__line--controls">
      <div class="transport-row__cluster transport-row__cluster--primary">
        <span class="transport-row__label">Transport</span>
        <button class="transport transport--compact" data-action="play-timeline" type="button" ${playing ? 'disabled' : ''}>Play</button>
        <button
          class="ghost-button ghost-button--compact transport-row__segment-loop ${segmentLoopOnly ? 'is-active' : ''}"
          data-action="toggle-segment-loop-only"
          type="button"
          ${hasSelection ? '' : 'disabled'}
          aria-pressed="${segmentLoopOnly ? 'true' : 'false'}"
        >
          Loop selected
        </button>
        <button class="ghost-button ghost-button--compact" data-action="pause-timeline" type="button" ${!playing ? 'disabled' : ''}>Pause</button>
        <button class="ghost-button ghost-button--compact" data-action="resume-timeline" type="button" ${!paused ? 'disabled' : ''}>Resume</button>
        <button class="ghost-button ghost-button--compact" data-action="stop-timeline" type="button" ${idle ? 'disabled' : ''}>Stop</button>
        <label class="toggle transport-row__loop-toggle">
          <input data-input="session-loop" type="checkbox" ${loop ? 'checked' : ''} />
          <span>Loop</span>
        </label>
        <button class="ghost-button ghost-button--compact" data-action="jump-selected" type="button" ${hasSelection ? '' : 'disabled'}>Jump to selected</button>
      </div>
    </div>
    <div class="transport-row__line transport-row__line--status">
      <div class="transport-row__readout" data-role="timeline-readout"></div>
    </div>
  `;
}

export function createApp(root: HTMLElement): void {
  const engine = new BinauralEngine();
  const sequencer = new SessionSequencer(engine);
  let masterVolume = loadMasterVolume();
  sequencer.setMasterVolume(masterVolume);

  let carrierDisplayMode: CarrierDisplayMode = 'note';
  const hashRestored = decodeShareableState(window.location.hash);
  const storedRestored = hashRestored ? null : loadStoredState();
  let restored =
    hashRestored ??
    storedRestored ??
    createInitialShareableState();
  const initialViewHint =
    hashRestored !== null
      ? decodeInitialViewHintFromHash(window.location.hash)
      : storedRestored !== null
        ? loadStoredStateViewHint()
        : null;
  const isFirstVisit = hashRestored === null && storedRestored === null;
  let playbackMode: AppViewMode =
    isFirstVisit
      ? 'catalog'
      : initialViewHint === 'analysis'
        ? 'analysis'
        : restored.mode;
  let session: SessionDefinition = restored.session;
  let composerDraft: ComposerDraft = restored.composer;
  let timelineUI = loadTimelineWorkspaceUIState(session);
  let manualDiagnosticsTab: ManualDiagnosticsTab = 'beat-map';
  let manualDiagnosticsOpen = false;
  let activeVisualizerId = DEFAULT_VISUALIZER_ID;
  let activeCatalogId: string | null = isFirstVisit ? null : (restored.presetId ?? null);
  let activeSavedId: string | null = null;
  let savedSessions: SavedSession[] = loadSavedSessions();
  let sessionMenuOpen = false;
  let pendingConfirmLabel: string | null = null;
  let pendingConfirmCatalogId: string | null = null;
  let pendingConfirmSavedId: string | null = null;
  let visualizerIntensity = 0.62;
  let lastVisualizerFrameMs: number | null = null;
  let visualizerPixiRuntime: PixiVisualizerRuntime | null = null;
  let visualizerPixiInitPromise: Promise<PixiVisualizerRuntime | null> | null = null;
  let visualizerPixiInitStartedAtMs: number | null = null;
  let visualizerPixiInitToken = 0;
  let visualizerPixiFailed = false;
  let visualizerPixiErrorLogged = false;
  let visualizerRendererMode: VisualizerRendererMode = 'pixi-webgl';
  let visualizerLastRendererError: string | null = null;
  let visualizerCanvasRef: HTMLCanvasElement | null = null;
  let visualizerBandActivity = createEmptyBandActivity();
  let visualizerDecayFrameId: number | null = null;
  let visualizerDecayStartMs: number | null = null;
  const ribbonFallbackStateByCanvas = new WeakMap<
    HTMLCanvasElement,
    {
      left: Float32Array;
      right: Float32Array;
      mid: Float32Array;
    }
  >();
  let revealedChipActionsSegmentId: string | null = null;
  let pendingRemoveSegmentId: string | null = null;
  let draggedSegmentId: string | null = null;
  let dragHoverSegmentId: string | null = null;
  let dragInsertPosition: TimelineDragInsertPosition | null = null;
  let timelineScrollAnimationFrameId: number | null = null;
  let lastPointerType: string = 'mouse';
  let headphoneNoticeVisible = !hasSeenHeadphoneNotice();
  let highVolumeWarningDismissed = hasSeenHighVolumeWarning();
  let shareButtonLabel = 'Copy share link';
  let shareFeedbackTimeoutId: number | null = null;
  let composerModalTrigger: HTMLElement | null = null;
  let envelopeDurationSeconds = 5;
  let envelopeSamples = computeEnvelope([], envelopeDurationSeconds, 0);
  let animationFrameId: number | null = null;
  let engineState: EngineSnapshot = engine.getSnapshot();
  let composerExplanation: string[] = [];
  let currentTheme: ThemeId =
    (document.documentElement.dataset.theme as ThemeId) || 'light';

  const applyTheme = (theme: ThemeId): void => {
    currentTheme = theme;
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  };

  const cycleTheme = (): void => {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
  };

  // Follow system preference changes when no manual override exists
  const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  if (loadTheme() === null) {
    systemDarkQuery.addEventListener('change', (e) => {
      if (loadTheme() === null) {
        applyTheme(e.matches ? 'dark' : 'light');
        renderLayout();
      }
    });
  }

  root.innerHTML = `
    <main class="shell">
      <div data-role="header-shell"></div>
      <div data-role="workspace-shell"></div>
    </main>
    <div data-role="confirm-dialog-container"></div>
  `;

  const headerShell = root.querySelector<HTMLElement>('[data-role="header-shell"]');
  const workspaceShell = root.querySelector<HTMLElement>('[data-role="workspace-shell"]');

  if (!headerShell || !workspaceShell) {
    throw new Error('App shell did not initialize.');
  }

  const showToast = (message: string, durationMs = 2200): void => {
    let container = document.querySelector<HTMLElement>('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('is-leaving');
      toast.addEventListener('transitionend', () => toast.remove());
      setTimeout(() => toast.remove(), 500);
    }, durationMs);
  };

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
    if (timelineUI.selectedSegmentId === null && timelineUI.segmentLoopOnly) {
      timelineUI = normalizeTimelineWorkspaceUIState(
        {
          ...timelineUI,
          segmentLoopOnly: false,
        },
        nextSession,
      );
    }
  };

  const selectedSegmentOrNull = (): SessionSegment | null =>
    session.segments.find((segment) => segment.id === timelineUI.selectedSegmentId) ??
    null;

  const selectedSegmentRequired = (): SessionSegment =>
    selectedSegmentOrNull() ?? session.segments[0] ?? createSessionSegment();

  const selectedSegmentIndex = (): number =>
    Math.max(0, session.segments.findIndex((segment) => segment.id === selectedSegmentRequired().id));

  const selectedState = (): SessionSoundState => selectedSegmentRequired().state;

  const createBlankSegmentStateFrom = (
    segment: SessionSegment,
  ): SessionSoundState =>
    sanitizeSessionSoundState({
      pairs: segment.state.pairs.map(() => sanitizeTonePair()),
    });

  const cloneSegmentOverrides = (
    segment: SessionSegment,
  ): SessionSegment['overrides'] =>
    segment.overrides.map((lane) => ({
      ...lane,
      keyframes: lane.keyframes.map((keyframe) => ({ ...keyframe })),
    }));

  const shareablePlaybackMode = (): PlaybackMode =>
    playbackMode === 'analysis' || playbackMode === 'catalog'
      ? 'timeline'
      : playbackMode;

  const currentShareableState = (): ShareableState => ({
    presetId: null,
    mode: shareablePlaybackMode(),
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
      masterGain: state.gain * masterVolume,
    });
    engine.setNoise(state.noise);
    syncEngineSnapshot();
  };

  const activePlaybackState = (): SessionPlaybackState =>
    sequencer.getPlaybackState();

  const timelineIsPlaying = (): boolean =>
    (playbackMode === 'timeline' || playbackMode === 'visualizer') &&
    activePlaybackState().status === 'playing';

  const syncSequencerPlaybackTarget = (): void => {
    if (playbackMode === 'visualizer') {
      sequencer.setLoopOverride(true);
      sequencer.setPlaybackTarget('session');
      return;
    }

    sequencer.setLoopOverride(null);

    if (
      playbackMode === 'timeline' &&
      timelineUI.segmentLoopOnly &&
      timelineUI.selectedSegmentId
    ) {
      sequencer.setPlaybackTarget({
        type: 'segment-loop',
        segmentId: timelineUI.selectedSegmentId,
      });
      return;
    }

    sequencer.setPlaybackTarget('session');
  };

  const headerMetaText = (): string => {
    if (playbackMode === 'analysis') {
      return `Segment ${selectedSegmentIndex() + 1} selected for manual audition`;
    }

    const playbackState = activePlaybackState();
    return `${formatSeconds(playbackState.totalElapsed)} / ${formatSeconds(playbackState.totalDuration)} · Segment ${playbackState.currentSegmentIndex + 1} · ${playbackState.currentSegmentPhase}`;
  };

  const syncHeader = (): void => {
    const statusPill = root.querySelector<HTMLElement>('[data-role="status-pill"]');
    const shareLabel = root.querySelector<HTMLElement>('[data-role="share-label"]');
    const manualTransport = root.querySelector<HTMLButtonElement>('[data-action="manual-transport"]');
    const headerMeta = root.querySelector<HTMLElement>('[data-role="header-meta"]');
    const headphoneNotice = root.querySelector<HTMLElement>('[data-role="headphone-notice"]');

    if (statusPill) {
      const timelineState = activePlaybackState();
      const running =
        playbackMode !== 'analysis'
          ? timelineState.status === 'playing'
          : engineState.playbackState === 'running';
      statusPill.textContent =
        playbackMode !== 'analysis'
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

    if (manualTransport) {
      manualTransport.textContent =
        engineState.playbackState === 'running'
          ? 'Stop selected segment'
          : 'Start selected segment';
    }

    if (headerMeta) {
      headerMeta.textContent = headerMetaText();
    }

    if (headphoneNotice) {
      const shouldShow = headphoneNoticeVisible;
      const isShowing = headphoneNotice.children.length > 0;
      if (shouldShow !== isShowing) {
        headphoneNotice.innerHTML = shouldShow
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
    }
  };

  const syncHighVolumeWarning = (): void => {
    const container = root.querySelector<HTMLElement>('[data-role="high-volume-warning"]');
    if (!container) {
      return;
    }
    const shouldShow = masterVolume > 0.45 && !highVolumeWarningDismissed;
    const isShowing = container.children.length > 0;
    if (shouldShow !== isShowing) {
      container.innerHTML = shouldShow
        ? `
          <div class="notice-banner" role="alert">
            <div>
              <strong>High volume warning.</strong>
              <p>Prolonged listening at high volume may cause hearing damage. Consider keeping volume at a comfortable level.</p>
            </div>
            <button class="ghost-button" data-action="dismiss-high-volume-warning">I understand</button>
          </div>
        `
        : '';
    }
  };

  const syncSessionMenu = (): void => {
    const menu = root.querySelector<HTMLElement>('[data-role="session-menu"]');
    if (!menu) {
      return;
    }
    if (!sessionMenuOpen) {
      menu.hidden = true;
      menu.innerHTML = '';
      return;
    }
    menu.hidden = false;
    menu.innerHTML = `
      ${catalog
        .map(
          (entry) => `
        <button class="session-menu__item ${entry.id === activeCatalogId ? 'is-active' : ''}"
          data-action="select-catalog-entry" data-catalog-id="${entry.id}" type="button">
          <strong>${escapeHtml(entry.label)}</strong>
        </button>
      `,
        )
        .join('')}
      ${
        savedSessions.length > 0
          ? `
        <hr class="session-menu__divider" />
        ${savedSessions
          .slice(0, 5)
          .map(
            (saved) => `
          <button class="session-menu__item ${saved.id === activeSavedId ? 'is-active' : ''}"
            data-action="select-saved-session" data-saved-id="${saved.id}" type="button">
            <strong>${escapeHtml(saved.label)}</strong>
          </button>
        `,
          )
          .join('')}
      `
          : ''
      }
      <hr class="session-menu__divider" />
      <button class="session-menu__item session-menu__item--action" data-action="save-current-session" type="button">
        Save current session
      </button>
      <button class="session-menu__item session-menu__item--action" data-action="show-catalog" type="button">
        Browse all sessions
      </button>
    `;
  };

  const syncConfirmDialog = (): void => {
    const container = root.querySelector<HTMLElement>('[data-role="confirm-dialog-container"]');
    if (!container) {
      return;
    }
    if (!pendingConfirmLabel) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = renderConfirmLoadDialog(
      pendingConfirmLabel,
      pendingConfirmCatalogId,
      pendingConfirmSavedId,
    );
  };

  const closeSessionMenu = (): void => {
    if (sessionMenuOpen) {
      sessionMenuOpen = false;
      syncSessionMenu();
    }
  };

  const clearConfirmDialog = (): void => {
    pendingConfirmLabel = null;
    pendingConfirmCatalogId = null;
    pendingConfirmSavedId = null;
    syncConfirmDialog();
  };

  const loadCatalogSession = (catalogId: string): void => {
    const entry = getCatalogEntry(catalogId);
    if (!entry) {
      return;
    }
    sequencer.stop();
    const nextSession = createSessionDefinition(
      entry.session as Partial<SessionDefinition>,
    );
    activeCatalogId = entry.id;
    activeSavedId = null;
    playbackMode = 'visualizer';
    replaceSession(nextSession, { rerender: false });
    renderLayout();
    persistAppState();
  };

  const loadSavedSessionById = (id: string): void => {
    const saved = savedSessions.find((s) => s.id === id);
    if (!saved) {
      return;
    }
    sequencer.stop();
    const nextSession = createSessionDefinition(saved.session);
    activeCatalogId = null;
    activeSavedId = saved.id;
    playbackMode = 'visualizer';
    replaceSession(nextSession, { rerender: false });
    renderLayout();
    persistAppState();
  };

  const syncSegmentMeta = (): void => {
    const container = root.querySelector<HTMLElement>('[data-role="segment-meta"]');
    const selectedTitle = root.querySelector<HTMLElement>('[data-role="selected-segment-title"]');
    const segment = selectedSegmentOrNull();
    if (selectedTitle) {
      selectedTitle.textContent = segment?.label || 'No segment selected';
    }

    if (!container || !segment) {
      return;
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
      selectedSegmentOrNull(),
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
        state.gain,
      );
    }

    const noiseCheckbox = supportControls.querySelector<HTMLInputElement>('input[type="checkbox"][data-input="noiseEnabled"]');
    const noiseRange = supportControls.querySelector<HTMLInputElement>('input[type="range"][data-input="noiseVolume"]');
    const noiseOutput = supportControls.querySelector<HTMLOutputElement>('[data-role="noise-output"]');
    const noiseModel = supportControls.querySelector<HTMLSelectElement>('select[data-input="noiseModel"]');
    const segmentGainRange = supportControls.querySelector<HTMLInputElement>('input[type="range"][data-input="segmentGain"]');
    const segmentGainOutput = supportControls.querySelector<HTMLOutputElement>('[data-role="segment-gain-output"]');
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
    if (segmentGainRange) {
      segmentGainRange.value = String(state.gain);
    }
    if (segmentGainOutput) {
      segmentGainOutput.value = formatPercent(state.gain);
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
      timelineUI.segmentLoopOnly,
      revealedChipActionsSegmentId,
      pendingRemoveSegmentId,
      activePlaybackState().status !== 'playing',
    );

    const scrollContainer = root.querySelector<HTMLElement>('[data-role="timeline-scroll"]');
    if (scrollContainer) {
      const nextLeft = Math.max(0, timelineUI.viewportLeft);
      scrollContainer.scrollLeft = nextLeft;
    }
    syncTimelineDragIndicators();
    syncTimelineChipActionOverlayPosition();
  };

  const stopTimelineScrollAnimation = (): void => {
    if (timelineScrollAnimationFrameId !== null) {
      window.cancelAnimationFrame(timelineScrollAnimationFrameId);
      timelineScrollAnimationFrameId = null;
    }
  };

  const animateTimelineScrollLeft = (
    scrollContainer: HTMLElement,
    targetLeft: number,
    requestedBehavior: ScrollBehavior,
  ): void => {
    const startLeft = scrollContainer.scrollLeft;
    const distance = targetLeft - startLeft;
    if (Math.abs(distance) < 0.5) {
      scrollContainer.scrollLeft = targetLeft;
      return;
    }

    if (requestedBehavior === 'auto') {
      stopTimelineScrollAnimation();
      scrollContainer.scrollLeft = targetLeft;
      return;
    }

    stopTimelineScrollAnimation();
    const distancePx = Math.abs(distance);
    const durationMs = Math.max(260, Math.min(760, 280 + distancePx * 0.45));
    const startedAt = performance.now();
    const easeInOutCubic = (progress: number): number =>
      progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

    const step = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = easeInOutCubic(progress);
      scrollContainer.scrollLeft = startLeft + distance * eased;
      if (progress < 1) {
        timelineScrollAnimationFrameId = window.requestAnimationFrame(step);
      } else {
        timelineScrollAnimationFrameId = null;
      }
    };

    timelineScrollAnimationFrameId = window.requestAnimationFrame(step);
  };

  const ensureTimelineSegmentVisible = (
    segmentId: string,
    requestedBehavior: ScrollBehavior = 'smooth',
  ): void => {
    const scrollContainer = root.querySelector<HTMLElement>('[data-role="timeline-scroll"]');
    if (!scrollContainer) {
      return;
    }

    const clip = scrollContainer.querySelector<HTMLElement>(`[data-clip-id="${segmentId}"]`);
    if (!clip) {
      return;
    }

    const viewportLeft = scrollContainer.scrollLeft;
    const viewportWidth = scrollContainer.clientWidth;
    if (viewportWidth <= 0) {
      return;
    }
    const viewportRight = viewportLeft + viewportWidth;

    const clipLeft = clip.offsetLeft;
    const clipWidth = clip.offsetWidth;
    const clipRight = clipLeft + clipWidth;

    let nextLeft = viewportLeft;
    if (clipWidth >= viewportWidth) {
      nextLeft = clipLeft;
    } else if (clipLeft < viewportLeft) {
      nextLeft = clipLeft;
    } else if (clipRight > viewportRight) {
      nextLeft = clipRight - viewportWidth;
    } else {
      return;
    }

    const maxLeft = Math.max(0, scrollContainer.scrollWidth - viewportWidth);
    const clampedLeft = Math.max(0, Math.min(nextLeft, maxLeft));
    if (Math.abs(clampedLeft - viewportLeft) < 0.5) {
      return;
    }

    animateTimelineScrollLeft(scrollContainer, clampedLeft, requestedBehavior);

    timelineUI = normalizeTimelineWorkspaceUIState(
      {
        ...timelineUI,
        viewportLeft: clampedLeft,
      },
      session,
    );
    saveTimelineWorkspaceUIState(timelineUI, session);
  };

  const syncTimelineDragIndicators = (): void => {
    const clipNodes =
      root.querySelectorAll<HTMLElement>('.timeline-clip');
    clipNodes.forEach((clip) => {
      clip.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    });

    if (draggedSegmentId) {
      const draggedClip = root.querySelector<HTMLElement>(
        `[data-clip-id="${draggedSegmentId}"]`,
      );
      draggedClip?.classList.add('is-dragging');
    }

    if (dragHoverSegmentId && dragInsertPosition) {
      const hoverClip = root.querySelector<HTMLElement>(
        `[data-clip-id="${dragHoverSegmentId}"]`,
      );
      if (hoverClip) {
        hoverClip.classList.add(
          dragInsertPosition === 'before' ? 'is-drop-before' : 'is-drop-after',
        );
      }
    }
  };

  const clearTimelineDragState = (): void => {
    draggedSegmentId = null;
    dragHoverSegmentId = null;
    dragInsertPosition = null;
    syncTimelineDragIndicators();
  };

  const applyTimelineDragReorder = (): void => {
    if (!draggedSegmentId || !dragHoverSegmentId || !dragInsertPosition) {
      return;
    }

    const currentIds = session.segments.map((segment) => segment.id);
    if (!currentIds.includes(draggedSegmentId)) {
      return;
    }

    const reorderedIds = currentIds.filter((id) => id !== draggedSegmentId);
    const hoverIndex = reorderedIds.indexOf(dragHoverSegmentId);
    if (hoverIndex < 0) {
      return;
    }

    const insertIndex =
      hoverIndex + (dragInsertPosition === 'after' ? 1 : 0);
    reorderedIds.splice(insertIndex, 0, draggedSegmentId);

    if (
      reorderedIds.length !== currentIds.length ||
      reorderedIds.every((id, index) => id === currentIds[index])
    ) {
      return;
    }

    sequencer.reorderSegments(reorderedIds);
    replaceSession(sequencer.getSession(), {
      preserveWorkspace: true,
      selectedSegmentId: timelineUI.selectedSegmentId,
    });
    ensureTimelineSegmentVisible(draggedSegmentId, 'smooth');
    persistAppState();
  };

  const syncTimelineChipActionOverlayPosition = (): void => {
    const scrollContainer = root.querySelector<HTMLElement>('[data-role="timeline-scroll"]');
    const overlay = root.querySelector<HTMLElement>('[data-role="timeline-chip-overlay"]');
    if (!scrollContainer || !overlay) {
      return;
    }

    const segmentId = overlay.dataset.segmentId;
    if (!segmentId) {
      return;
    }

    const clip = scrollContainer.querySelector<HTMLElement>(`[data-clip-id="${segmentId}"]`);
    if (!clip) {
      return;
    }

    const scrollRect = scrollContainer.getBoundingClientRect();
    const clipRect = clip.getBoundingClientRect();
    const overlayWidth = Math.max(
      overlay.offsetWidth,
      TIMELINE_CHIP_ACTIONS.overlayMinWidthPx,
    );
    const overlayHeight = Math.max(overlay.offsetHeight, 28);
    const minLeft = 4;
    const maxLeft = Math.max(
      minLeft,
      scrollContainer.clientWidth - overlayWidth - 4,
    );

    const preferredRightLeft =
      clipRect.right - scrollRect.left - overlayWidth - 6;
    const fallbackLeft = clipRect.left - scrollRect.left + 6;
    let left =
      preferredRightLeft < minLeft || preferredRightLeft > maxLeft
        ? fallbackLeft
        : preferredRightLeft;
    left = Math.max(minLeft, Math.min(left, maxLeft));

    const minTop = 4;
    const maxTop = Math.max(
      minTop,
      scrollContainer.clientHeight - overlayHeight - 4,
    );
    const top = Math.max(
      minTop,
      Math.min(clipRect.top - scrollRect.top + 6, maxTop),
    );

    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
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
        transport.innerHTML = renderTimelineTransport(
          playbackState,
          session.loop,
          timelineUI.selectedSegmentId,
          timelineUI.segmentLoopOnly,
        );
      }

      const playButton = transport.querySelector<HTMLButtonElement>('[data-action="play-timeline"]');
      const pauseButton = transport.querySelector<HTMLButtonElement>('[data-action="pause-timeline"]');
      const resumeButton = transport.querySelector<HTMLButtonElement>('[data-action="resume-timeline"]');
      const stopButton = transport.querySelector<HTMLButtonElement>('[data-action="stop-timeline"]');
      const segmentLoopButton = transport.querySelector<HTMLButtonElement>(
        '[data-action="toggle-segment-loop-only"]',
      );
      const jumpSelectedButton = transport.querySelector<HTMLButtonElement>(
        '[data-action="jump-selected"]',
      );
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
      if (segmentLoopButton) {
        segmentLoopButton.disabled = timelineUI.selectedSegmentId === null;
        segmentLoopButton.classList.toggle('is-active', timelineUI.segmentLoopOnly);
        segmentLoopButton.setAttribute(
          'aria-pressed',
          timelineUI.segmentLoopOnly ? 'true' : 'false',
        );
      }
      if (jumpSelectedButton) {
        jumpSelectedButton.disabled = timelineUI.selectedSegmentId === null;
      }
      if (loopCheckbox) {
        loopCheckbox.checked = session.loop;
      }
      if (readout) {
        readout.textContent = `${formatSeconds(playbackState.totalElapsed)} / ${formatSeconds(playbackState.totalDuration)} · Segment ${playbackState.currentSegmentIndex + 1} · ${playbackState.currentSegmentPhase}`;
      }
    });
  };

  const syncVisualizerTransport = (): void => {
    const transport = root.querySelector<HTMLElement>('[data-role="visualizer-transport"]');
    if (!transport) {
      return;
    }

    const playbackState = activePlaybackState();
    const playing = playbackState.status === 'playing';
    const playButton = transport.querySelector<HTMLButtonElement>('[data-action="visualizer-play"]');
    const pauseButton = transport.querySelector<HTMLButtonElement>('[data-action="visualizer-pause"]');
    const readout = transport.querySelector<HTMLElement>('[data-role="visualizer-readout"]');

    if (!playButton || !pauseButton || !readout) {
      transport.innerHTML = renderVisualizerTransport(playbackState);
      return;
    }

    playButton.disabled = playing;
    pauseButton.disabled = !playing;
    readout.textContent = `${formatSeconds(playbackState.totalElapsed)} / ${formatSeconds(playbackState.totalDuration)} · Segment ${playbackState.currentSegmentIndex + 1} · ${playbackState.currentSegmentPhase}`;
  };

  const syncVisualizerBandLeds = (): void => {
    const container = root.querySelector<HTMLElement>('[data-role="visualizer-band-leds"]');
    if (!container) {
      return;
    }

    const leds = container.querySelectorAll<HTMLElement>('[data-band]');
    leds.forEach((led) => {
      const band = led.dataset.band as VisualizerBand | undefined;
      if (!band) {
        return;
      }
      const level = visualizerBandActivity.levels[band] ?? 0;
      led.style.setProperty('--band-level', level.toFixed(3));
      led.classList.toggle('is-active', visualizerBandActivity.activeBands.includes(band));
      led.classList.toggle('is-dominant', visualizerBandActivity.dominant === band);
    });
  };

  const normalizeVisualizerRendererError = (error: unknown): string => {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }
    if (typeof error === 'string' && error.trim().length > 0) {
      return error.trim();
    }
    return 'Unknown visualizer renderer error';
  };

  const syncVisualizerRuntimeStatus = (): void => {
    const initPending =
      visualizerPixiInitPromise !== null &&
      visualizerPixiRuntime === null &&
      !visualizerPixiFailed;
    const status = root.querySelector<HTMLElement>(
      '[data-role="visualizer-renderer-status"]',
    );
    if (status) {
      status.textContent =
        visualizerRendererMode === 'pixi-webgl'
          ? initPending
            ? 'Renderer: Pixi (initializing)'
            : 'Renderer: Pixi'
          : 'Renderer: Compatibility';
      status.dataset.mode = visualizerRendererMode;
      status.dataset.pending = initPending ? 'true' : 'false';
      if (visualizerLastRendererError) {
        status.title = visualizerLastRendererError;
      } else {
        status.removeAttribute('title');
      }
    }

    (
      window as Window & {
        __neurotoneViz?: {
          rendererMode: VisualizerRendererMode;
          activeVisualizerId: string;
          initPending: boolean;
          lastRendererError?: string;
        };
      }
    ).__neurotoneViz = {
      rendererMode: visualizerRendererMode,
      activeVisualizerId,
      initPending,
      ...(visualizerLastRendererError
        ? { lastRendererError: visualizerLastRendererError }
        : {}),
    };
  };

  const destroyVisualizerRuntime = (): void => {
    if (visualizerPixiRuntime) {
      try {
        visualizerPixiRuntime.destroy();
      } catch {
        // Runtime teardown failures are non-fatal; we always continue with renderer reset.
      }
      visualizerPixiRuntime = null;
    }
    visualizerPixiInitPromise = null;
    visualizerPixiInitStartedAtMs = null;
  };

  const resetVisualizerRenderer = (): void => {
    visualizerPixiInitToken += 1;
    destroyVisualizerRuntime();
    visualizerPixiFailed = false;
    visualizerPixiErrorLogged = false;
    visualizerRendererMode = 'pixi-webgl';
    visualizerLastRendererError = null;
    syncVisualizerRuntimeStatus();
  };

  const switchVisualizerToCompatibility = (
    error: unknown,
    contextMessage: string,
  ): void => {
    visualizerPixiInitToken += 1;
    destroyVisualizerRuntime();
    visualizerPixiFailed = true;
    visualizerRendererMode = 'compatibility';
    visualizerLastRendererError = normalizeVisualizerRendererError(error);
    if (!visualizerPixiErrorLogged) {
      console.warn(contextMessage, error);
      visualizerPixiErrorLogged = true;
    }
    syncVisualizerRuntimeStatus();
  };

  const drawSignalTrace = (
    context: CanvasRenderingContext2D,
    values: Float32Array,
    width: number,
    centerY: number,
    amplitude: number,
  ): void => {
    if (values.length === 0) {
      return;
    }
    const denominator = Math.max(values.length - 1, 1);
    context.beginPath();
    for (let index = 0; index < values.length; index += 1) {
      const x = (index / denominator) * width;
      const y = centerY - values[index]! * amplitude;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
  };

  const drawEnvelopeFieldFallback = (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    nowMs: number,
  ): void => {
    const centerY = height * 0.52;
    const signal = synthesizeStereoSignal(engineState.pairs, {
      sampleCount: Math.max(280, Math.floor(width * 1.1)),
      windowSeconds: Math.max(4.6, envelopeDurationSeconds * 1.04),
      centerTimeSeconds: activePlaybackState().totalElapsed,
      motionScale: 0.9,
    });
    context.clearRect(0, 0, width, height);
    context.fillStyle = 'rgba(250,246,238,0.88)';
    context.fillRect(0, 0, width, height);
    context.save();
    context.globalAlpha = 0.16;
    context.fillStyle = 'rgba(170,122,85,0.18)';
    context.fillRect(0, height * 0.18, width, height * 0.66);
    context.restore();

    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = 'rgba(177,122,76,0.22)';
    context.lineWidth = 4.2;
    drawSignalTrace(context, signal.mono, width, centerY, height * 0.24);
    context.strokeStyle = 'rgba(132,74,34,0.82)';
    context.lineWidth = 1.8;
    drawSignalTrace(context, signal.mono, width, centerY, height * 0.26);

    const haloX = width * (0.82 + Math.sin(nowMs / 9000) * 0.03);
    const haloY = height * 0.24;
    const haloRadius = Math.max(16, Math.min(width, height) * 0.06);
    const gradient = context.createRadialGradient(
      haloX,
      haloY,
      haloRadius * 0.1,
      haloX,
      haloY,
      haloRadius * 1.8,
    );
    gradient.addColorStop(0, 'rgba(166,108,60,0.28)');
    gradient.addColorStop(1, 'rgba(166,108,60,0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(haloX, haloY, haloRadius * 1.8, 0, Math.PI * 2);
    context.fill();
  };

  const drawStereoDriftRibbonsFallback = (
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    nowMs: number,
  ): void => {
    const intensity = clampNumeric(visualizerIntensity, 0, 1);
    const signal = synthesizeStereoSignal(engineState.pairs, {
      sampleCount: Math.max(420, Math.floor(width * 1.35)),
      windowSeconds: 4.4,
      centerTimeSeconds: activePlaybackState().totalElapsed,
      motionScale: 0.78,
    });
    const previous = ribbonFallbackStateByCanvas.get(canvas);
    const state =
      previous &&
      previous.left.length === signal.left.length &&
      previous.right.length === signal.right.length
        ? previous
        : {
            left: signal.left.slice(),
            right: signal.right.slice(),
            mid: new Float32Array(signal.left.length),
          };
    const temporalAlpha = 0.14 + intensity * 0.12;
    for (let index = 0; index < signal.left.length; index += 1) {
      const leftPrev = index > 0 ? signal.left[index - 1]! : signal.left[index]!;
      const leftNext =
        index < signal.left.length - 1 ? signal.left[index + 1]! : signal.left[index]!;
      const rightPrev = index > 0 ? signal.right[index - 1]! : signal.right[index]!;
      const rightNext =
        index < signal.right.length - 1 ? signal.right[index + 1]! : signal.right[index]!;
      const leftSpatial = leftPrev * 0.2 + signal.left[index]! * 0.6 + leftNext * 0.2;
      const rightSpatial = rightPrev * 0.2 + signal.right[index]! * 0.6 + rightNext * 0.2;
      state.left[index] = state.left[index]! * (1 - temporalAlpha) + leftSpatial * temporalAlpha;
      state.right[index] =
        state.right[index]! * (1 - temporalAlpha) + rightSpatial * temporalAlpha;
      state.mid[index] = (state.left[index]! + state.right[index]!) * 0.5;
    }
    ribbonFallbackStateByCanvas.set(canvas, state);

    context.clearRect(0, 0, width, height);
    context.fillStyle = 'rgba(250,246,238,0.9)';
    context.fillRect(0, 0, width, height);
    const drift = Math.sin(nowMs / 7800) * height * 0.024;
    const spread = height * (0.34 + intensity * 0.1);
    const centerY = height * 0.5;
    const leftMid = centerY - spread * 0.5 + drift;
    const rightMid = centerY + spread * 0.5 - drift;
    const amplitude = height * (0.205 + intensity * 0.155);
    const washGradient = context.createLinearGradient(0, height * 0.08, 0, height * 0.92);
    washGradient.addColorStop(0, 'rgba(116,176,188,0.1)');
    washGradient.addColorStop(1, 'rgba(167,144,212,0.1)');
    context.fillStyle = washGradient;
    context.fillRect(0, height * 0.08, width, height * 0.84);

    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = `rgba(116,176,188,${(0.18 + intensity * 0.09).toFixed(3)})`;
    context.lineWidth = 7.5 + intensity * 2.5;
    drawSignalTrace(context, state.left, width, leftMid, amplitude * 1.05);
    context.strokeStyle = `rgba(167,144,212,${(0.15 + intensity * 0.08).toFixed(3)})`;
    context.lineWidth = 7.5 + intensity * 2.5;
    drawSignalTrace(context, state.right, width, rightMid, amplitude * 0.98);

    context.strokeStyle = `rgba(95,152,163,${(0.64 + intensity * 0.16).toFixed(3)})`;
    context.lineWidth = 2.4 + intensity * 1.05;
    drawSignalTrace(context, state.left, width, leftMid, amplitude);
    context.strokeStyle = `rgba(135,114,181,${(0.6 + intensity * 0.15).toFixed(3)})`;
    context.lineWidth = 2.2 + intensity * 1.05;
    drawSignalTrace(context, state.right, width, rightMid, amplitude * 0.96);

    context.strokeStyle = `rgba(153,101,61,${(0.18 + intensity * 0.1).toFixed(3)})`;
    context.lineWidth = 1.2;
    drawSignalTrace(context, state.mid, width, centerY, amplitude * 0.5);

    const haloX = width * 0.82;
    const haloY = height * 0.26;
    const haloRadius = Math.max(18, Math.min(width, height) * 0.16);
    const haloGradient = context.createRadialGradient(
      haloX,
      haloY,
      haloRadius * 0.1,
      haloX,
      haloY,
      haloRadius * 1.8,
    );
    haloGradient.addColorStop(0, 'rgba(166,108,60,0.22)');
    haloGradient.addColorStop(1, 'rgba(166,108,60,0)');
    context.fillStyle = haloGradient;
    context.beginPath();
    context.arc(haloX, haloY, haloRadius * 1.8, 0, Math.PI * 2);
    context.fill();
  };

  const drawSpectralAuroraFallback = (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void => {
    const intensity = clampNumeric(visualizerIntensity, 0, 1);
    const top = height * 0.08;
    const bottom = height * 0.94;
    const drawable = bottom - top;
    const signal = synthesizeStereoSignal(engineState.pairs, {
      sampleCount: Math.max(2176, Math.floor(width * 2.4)),
      windowSeconds: 1.35,
      centerTimeSeconds: activePlaybackState().totalElapsed,
      motionScale: 0.86,
    });
    const stft = computeSyntheticStft(signal.mono, 96, 12);
    const bands = sampleLogBands(stft, 42);

    context.clearRect(0, 0, width, height);
    context.fillStyle = 'rgba(249,245,238,0.93)';
    context.fillRect(0, 0, width, height);
    const gradient = context.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, 'rgba(124,164,188,0.16)');
    gradient.addColorStop(0.45, 'rgba(184,140,99,0.14)');
    gradient.addColorStop(1, 'rgba(120,191,134,0.18)');
    context.fillStyle = gradient;
    context.fillRect(0, top, width, drawable);

    const frameSpan = Math.max(bands.frameCount - 1, 1);
    const bandSpan = Math.max(bands.bandCount - 1, 1);
    const enhanced = new Float32Array(bands.values.length);
    const bandPresence = new Float32Array(bands.bandCount);

    for (let frameIndex = 0; frameIndex < bands.frameCount; frameIndex += 1) {
      for (let bandIndex = 0; bandIndex < bands.bandCount; bandIndex += 1) {
        const baseIndex = frameIndex * bands.bandCount + bandIndex;
        const bandRatio = bandIndex / bandSpan;
        const center = bands.values[baseIndex] ?? 0;
        const prev = bandIndex > 0 ? (bands.values[baseIndex - 1] ?? center) : center;
        const next =
          bandIndex < bands.bandCount - 1 ? (bands.values[baseIndex + 1] ?? center) : center;
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

    context.lineJoin = 'round';
    context.lineCap = 'round';
    for (let bandIndex = 0; bandIndex < bands.bandCount; bandIndex += 1) {
      const bandRatio = bandIndex / bandSpan;
      const hue = 205 - bandRatio * 138;
      const presence = Math.min(1, bandPresence[bandIndex]! * 1.6);
      const floorLift = presence * (0.18 + intensity * 0.16);
      const baseY = bottom - bandRatio * drawable;

      context.strokeStyle = `hsla(${hue.toFixed(1)}, 62%, 56%, ${(0.18 + presence * 0.42).toFixed(3)})`;
      context.lineWidth = 2.2 + intensity * 2.3;
      context.beginPath();
      for (let frameIndex = 0; frameIndex < bands.frameCount; frameIndex += 1) {
        const x = (frameIndex / frameSpan) * width;
        const lifted = Math.max(
          floorLift,
          enhanced[frameIndex * bands.bandCount + bandIndex] ?? floorLift,
        );
        const y = baseY - lifted * (20 + intensity * 34);
        if (frameIndex === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }
      context.stroke();

      context.strokeStyle = `hsla(${hue.toFixed(1)}, 70%, 66%, ${(0.16 + presence * 0.56).toFixed(3)})`;
      context.lineWidth = 1.05 + intensity * 0.75;
      context.beginPath();
      for (let frameIndex = 0; frameIndex < bands.frameCount; frameIndex += 1) {
        const x = (frameIndex / frameSpan) * width;
        const lifted = Math.max(
          floorLift,
          enhanced[frameIndex * bands.bandCount + bandIndex] ?? floorLift,
        );
        const y = baseY - lifted * (20 + intensity * 34);
        if (frameIndex === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }
      context.stroke();
    }
  };

  const drawVisualizerFallback = (
    canvas: HTMLCanvasElement,
    moduleId: string,
    nowMs: number,
  ): HTMLCanvasElement | null => {
    let drawCanvas = canvas;
    let context = drawCanvas.getContext('2d');
    if (!context) {
      const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
      replacement.className = canvas.className;
      replacement.height = canvas.height || 280;
      replacement.setAttribute('data-role', 'visualizer-canvas');
      canvas.replaceWith(replacement);
      drawCanvas = replacement;
      visualizerCanvasRef = replacement;
      context = drawCanvas.getContext('2d');
      if (!context) {
        return null;
      }
    }

    const measured = drawCanvas.getBoundingClientRect();
    const width = Math.max(
      360,
      Math.floor(
        Number.isFinite(measured.width) && measured.width > 0
          ? measured.width
          : drawCanvas.offsetWidth || drawCanvas.clientWidth || 860,
      ),
    );
    const height = Math.max(
      260,
      Math.floor(
        Number.isFinite(measured.height) && measured.height > 0
          ? measured.height
          : drawCanvas.offsetHeight || drawCanvas.clientHeight || 360,
      ),
    );
    if (drawCanvas.width !== width) {
      drawCanvas.width = width;
    }
    if (drawCanvas.height !== height) {
      drawCanvas.height = height;
    }

    if (moduleId === 'stereo-bloom-orb') {
      drawStereoDriftRibbonsFallback(drawCanvas, context, width, height, nowMs);
      return drawCanvas;
    }

    if (moduleId === 'spectral-aurora') {
      drawSpectralAuroraFallback(context, width, height);
      return drawCanvas;
    }

    drawEnvelopeFieldFallback(context, width, height, nowMs);
    return drawCanvas;
  };

  const startVisualizerDecay = (): void => {
    if (visualizerDecayFrameId !== null) return;
    visualizerDecayStartMs = performance.now();
    const tick = (): void => {
      const now = performance.now();
      syncVisualizerCanvas(now);
      if (visualizerDecayStartMs !== null && now - visualizerDecayStartMs > 2000) {
        stopVisualizerDecay();
        syncVisualizerCanvas(performance.now());
        return;
      }
      visualizerDecayFrameId = requestAnimationFrame(tick);
    };
    visualizerDecayFrameId = requestAnimationFrame(tick);
  };

  const stopVisualizerDecay = (): void => {
    if (visualizerDecayFrameId !== null) {
      cancelAnimationFrame(visualizerDecayFrameId);
      visualizerDecayFrameId = null;
    }
    visualizerDecayStartMs = null;
  };

  const syncVisualizerCanvas = (nowMs = performance.now()): void => {
    const playing = activePlaybackState().status === 'playing';
    const beatMap = playing ? computeBeatMap(engineState.pairs) : [];
    visualizerBandActivity = advanceBandActivity(
      visualizerBandActivity,
      beatMap,
      0.2,
    );
    syncVisualizerBandLeds();

    const canvas = root.querySelector<HTMLCanvasElement>('[data-role="visualizer-canvas"]');
    if (!canvas) {
      lastVisualizerFrameMs = null;
      visualizerCanvasRef = null;
      destroyVisualizerRuntime();
      syncVisualizerRuntimeStatus();
      return;
    }

    if (canvas !== visualizerCanvasRef) {
      visualizerCanvasRef = canvas;
      resetVisualizerRenderer();
    }

    const deltaMs =
      lastVisualizerFrameMs === null
        ? 16.67
        : clampNumeric(nowMs - lastVisualizerFrameMs, 0, 250);
    lastVisualizerFrameMs = nowMs;

    const measured = canvas.getBoundingClientRect();
    const width = Math.max(
      360,
      Math.floor(
        Number.isFinite(measured.width) && measured.width > 0
          ? measured.width
          : canvas.offsetWidth || canvas.clientWidth || 860,
      ),
    );
    const height = Math.max(
      260,
      Math.floor(
        Number.isFinite(measured.height) && measured.height > 0
          ? measured.height
          : canvas.offsetHeight || canvas.clientHeight || 360,
      ),
    );
    const frame = {
      engineState,
      playbackState: activePlaybackState(),
      durationSeconds: envelopeDurationSeconds,
      nowMs,
      deltaMs,
      intensity: visualizerIntensity,
      bandActivity: visualizerBandActivity,
      isPlaying: playing,
    };

    if (visualizerPixiFailed) {
      drawVisualizerFallback(canvas, activeVisualizerId, nowMs);
      syncVisualizerRuntimeStatus();
      return;
    }

    if (visualizerPixiRuntime) {
      try {
        visualizerPixiRuntime.resize(width, height);
        visualizerPixiRuntime.render(activeVisualizerId, frame);
        visualizerRendererMode = 'pixi-webgl';
        visualizerLastRendererError = null;
        syncVisualizerRuntimeStatus();
      } catch (error) {
        switchVisualizerToCompatibility(
          error,
          'Visualizer renderer switched to compatibility mode.',
        );
        drawVisualizerFallback(canvas, activeVisualizerId, nowMs);
      }
      return;
    }

    if (
      visualizerPixiInitPromise &&
      visualizerPixiInitStartedAtMs !== null &&
      nowMs - visualizerPixiInitStartedAtMs > VISUALIZER_PIXI_INIT_TIMEOUT_MS
    ) {
      switchVisualizerToCompatibility(
        new Error(
          `PIXI initialization timed out after ${VISUALIZER_PIXI_INIT_TIMEOUT_MS}ms.`,
        ),
        'Visualizer renderer timed out during initialization. Using compatibility mode.',
      );
      drawVisualizerFallback(canvas, activeVisualizerId, nowMs);
      return;
    }

    if (!visualizerPixiInitPromise) {
      const initToken = ++visualizerPixiInitToken;
      visualizerPixiInitStartedAtMs = nowMs;
      visualizerPixiInitPromise = PixiVisualizerRuntime.create(canvas, width, height)
        .then((runtime) => {
          if (initToken !== visualizerPixiInitToken) {
            runtime.destroy();
            return null;
          }
          if (!root.contains(canvas) || canvas !== visualizerCanvasRef) {
            runtime.destroy();
            visualizerPixiInitPromise = null;
            return null;
          }
          visualizerPixiRuntime = runtime;
          visualizerRendererMode = 'pixi-webgl';
          visualizerLastRendererError = null;
          visualizerPixiInitPromise = null;
          visualizerPixiInitStartedAtMs = null;
          syncVisualizerRuntimeStatus();
          requestAnimationFrame(() => syncVisualizerCanvas(performance.now()));
          return runtime;
        })
        .catch((error) => {
          if (initToken !== visualizerPixiInitToken) {
            return null;
          }
          switchVisualizerToCompatibility(
            error,
            'Visualizer renderer failed to initialize. Using compatibility mode.',
          );
          const liveCanvas =
            root.querySelector<HTMLCanvasElement>('[data-role="visualizer-canvas"]') ??
            canvas;
          drawVisualizerFallback(liveCanvas, activeVisualizerId, performance.now());
          return null;
        });
    }

    // Keep this canvas untouched while PIXI initialization is pending.
    // Drawing a 2D fallback here can lock the context and cause WebGL init to fail.
    syncVisualizerRuntimeStatus();
    return;
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
      timelineUI.segmentLoopOnly,
      timelineUI.selectedSegmentId,
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
      const progress = computeClipProgress(
        clip,
        playbackState,
        timelineUI.segmentLoopOnly,
        timelineUI.selectedSegmentId,
      );
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
      animationFrameId = null;
      return;
    }

    const playbackProgress =
      playbackMode !== 'analysis'
        ? timelineIsPlaying()
          ? ((activePlaybackState().totalElapsed % envelopeDurationSeconds) /
              envelopeDurationSeconds)
          : -1
        : engineState.playbackState === 'running'
          ? ((timestampMs / 1000) % envelopeDurationSeconds) / envelopeDurationSeconds
        : -1;

    drawEnvelope(canvas, envelopeSamples, playbackProgress);

    if (
      (playbackMode !== 'analysis' && timelineIsPlaying()) ||
      (playbackMode === 'analysis' && engineState.playbackState === 'running')
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

    if (!envelopeCanvas && animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

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
        (playbackMode !== 'analysis' && timelineIsPlaying()) ||
        (playbackMode === 'analysis' && engineState.playbackState === 'running')
      ) {
        animationFrameId = window.requestAnimationFrame(drawEnvelopeFrame);
      }
    }

    if (metrics) {
      const totalLayerGain = engineState.pairs.reduce((sum, pair) => sum + pair.gain, 0);
      metrics.innerHTML = [
        renderMetric('Session segments', String(session.segments.length)),
        renderMetric(
          'Mode',
          playbackMode === 'timeline'
            ? 'Timeline'
            : playbackMode === 'visualizer'
              ? 'Visualizer'
              : 'Analysis',
        ),
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
      shell.dataset.timelineTab = playbackMode;
    }

    if (playbackMode === 'catalog') {
      headerShell.innerHTML = renderCatalogHeader(currentTheme, !isFirstVisit);
      workspaceShell.innerHTML = renderCatalogWorkspace(savedSessions);
      syncConfirmDialog();
      return;
    }

    headerShell.innerHTML =
      playbackMode === 'analysis'
        ? renderAnalysisHeader(session, shareButtonLabel, masterVolume, currentTheme)
        : renderTimelineHeader(session, shareButtonLabel, playbackMode, masterVolume, currentTheme);

    workspaceShell.innerHTML =
      playbackMode === 'timeline'
        ? renderTimelineTabWorkspace(
            session,
            timelineUI,
            carrierDisplayMode,
            composerDraft,
          )
        : playbackMode === 'visualizer'
          ? renderVisualizerWorkspace(
              activeVisualizerId,
              visualizerBandActivity,
            )
          : renderManualWorkspace(
              session,
              timelineUI.selectedSegmentId,
              carrierDisplayMode,
              manualDiagnosticsTab,
              manualDiagnosticsOpen,
            );

    syncHeader();
    syncSessionMenu();
    syncConfirmDialog();
    syncComposerOutput();
    syncGeneratedSummary();
    syncSegmentMeta();
    syncSegmentOverrides();
    syncLayerEditor(true);
    syncSupportControls(true);
    syncTimelineCanvas();
    syncAdvancedCanvas();
    syncTimelineTransport();
    syncVisualizerTransport();
    syncVisualizerCanvas();
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
    syncVisualizerTransport();
    syncVisualizerCanvas();
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
      rerender?: boolean;
    } = {},
  ): void => {
    session = createSessionDefinition(nextSession);
    if (
      pendingRemoveSegmentId &&
      !session.segments.some((segment) => segment.id === pendingRemoveSegmentId)
    ) {
      pendingRemoveSegmentId = null;
    }

    ensureTimelineUI(
      options.preserveWorkspace === false
        ? {
            tab: options.tab ?? 'timeline',
            inspectorTab: options.inspectorTab ?? 'segment',
            selectedSegmentId:
              options.selectedSegmentId === undefined
                ? session.segments[0]?.id ?? null
                : options.selectedSegmentId,
            selectedPairId:
              options.selectedPairId === undefined
                ? session.segments[0]?.state.pairs[0]?.id ?? null
                : options.selectedPairId,
            zoomLevel: timelineUI.zoomLevel,
            viewportLeft: 0,
            selectedLaneId:
              options.selectedLaneId === undefined
                ? null
                : options.selectedLaneId,
            selectedKeyframeId:
              options.selectedKeyframeId === undefined
                ? null
                : options.selectedKeyframeId,
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
            selectedSegmentId:
              options.selectedSegmentId === undefined
                ? timelineUI.selectedSegmentId
                : options.selectedSegmentId,
            selectedPairId:
              options.selectedPairId === undefined
                ? timelineUI.selectedPairId
                : options.selectedPairId,
            selectedLaneId:
              options.selectedLaneId === undefined
                ? timelineUI.selectedLaneId
                : options.selectedLaneId,
            selectedKeyframeId:
              options.selectedKeyframeId === undefined
                ? timelineUI.selectedKeyframeId
                : options.selectedKeyframeId,
            analysisDockOpen:
              options.analysisDockOpen ?? timelineUI.analysisDockOpen,
            analysisDockTab:
              options.analysisDockTab ?? timelineUI.analysisDockTab,
            composerModalOpen:
              options.composerModalOpen ?? timelineUI.composerModalOpen,
          },
      session,
    );

    sequencer.replaceSession(session);
    syncSequencerPlaybackTarget();

    if (
      !timelineUI.segmentLoopOnly &&
      activePlaybackState().status !== 'playing' &&
      selectedSegmentOrNull()
    ) {
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
    const selected = selectedSegmentOrNull();
    if (!selected) {
      return;
    }

    const updatedSegments = session.segments.map((segment) =>
      segment.id === selected.id
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
    syncVisualizerTransport();
    syncTimelinePlaybackVisuals();
    syncAdvancedPlaybackVisuals();
    syncVisualizerCanvas();
    syncDiagnostics();
    if (
      playbackMode === 'visualizer' &&
      activePlaybackState().status === 'complete'
    ) {
      startVisualizerDecay();
    }
  });

  sequencer.onSegmentChange(() => {
    syncTimelinePlaybackVisuals();
    syncAdvancedPlaybackVisuals();
    syncTimelineTransport();
    syncVisualizerTransport();
    syncVisualizerCanvas();
    syncHeader();
  });

  sequencer.load(session);
  ensureTimelineUI(undefined, session);
  if (playbackMode === 'analysis' && timelineUI.selectedSegmentId === null) {
    ensureTimelineUI({
      selectedSegmentId: session.segments[0]?.id ?? null,
      segmentLoopOnly: false,
    });
  }
  syncSequencerPlaybackTarget();
  if (!timelineUI.segmentLoopOnly && selectedSegmentOrNull()) {
    sequencer.seekToSegment(selectedSegmentIndex());
  }
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
        syncTimelineChipActionOverlayPosition();
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

  root.addEventListener(
    'pointerdown',
    (event) => {
      if (!(event instanceof PointerEvent)) {
        return;
      }
      lastPointerType = event.pointerType || 'mouse';
    },
    true,
  );

  root.addEventListener('dragstart', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const clipButton = target.closest<HTMLElement>('.timeline-clip__button');
    if (!clipButton) {
      return;
    }

    if (activePlaybackState().status === 'playing') {
      event.preventDefault();
      return;
    }

    if (target.closest('.timeline-chip-actions')) {
      event.preventDefault();
      return;
    }

    const segmentId = clipButton.dataset.segmentId;
    if (!segmentId) {
      return;
    }

    draggedSegmentId = segmentId;
    dragHoverSegmentId = null;
    dragInsertPosition = null;
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', segmentId);
      event.dataTransfer.effectAllowed = 'move';
    }
    syncTimelineDragIndicators();
  });

  root.addEventListener('dragover', (event) => {
    if (!draggedSegmentId) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const timelineScroll = target.closest<HTMLElement>('[data-role="timeline-scroll"]');
    if (!timelineScroll) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }

    const hoverClip = target.closest<HTMLElement>('[data-clip-id]');
    if (!hoverClip) {
      dragHoverSegmentId = null;
      dragInsertPosition = null;
      syncTimelineDragIndicators();
      return;
    }

    const hoverSegmentId = hoverClip.dataset.clipId ?? null;
    if (!hoverSegmentId || hoverSegmentId === draggedSegmentId) {
      dragHoverSegmentId = null;
      dragInsertPosition = null;
      syncTimelineDragIndicators();
      return;
    }

    const hoverRect = hoverClip.getBoundingClientRect();
    dragHoverSegmentId = hoverSegmentId;
    dragInsertPosition =
      event.clientX < hoverRect.left + hoverRect.width / 2 ? 'before' : 'after';
    syncTimelineDragIndicators();
  });

  root.addEventListener('drop', (event) => {
    if (!draggedSegmentId) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      clearTimelineDragState();
      return;
    }

    const timelineScroll = target.closest<HTMLElement>('[data-role="timeline-scroll"]');
    if (!timelineScroll) {
      clearTimelineDragState();
      return;
    }

    event.preventDefault();
    applyTimelineDragReorder();
    clearTimelineDragState();
  });

  root.addEventListener('dragend', () => {
    clearTimelineDragState();
  });

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

    if (inputKey === 'segmentGain') {
      const gainValue = Number((target as HTMLInputElement).value);
      updateSelectedSegment(
        (segment) => ({
          ...segment,
          state: sanitizeSessionSoundState({
            ...segment.state,
            gain: gainValue,
          }),
        }),
        false,
      );
      const output = (target as HTMLElement).closest('label')?.querySelector<HTMLOutputElement>('[data-role="segment-gain-output"]');
      if (output) {
        output.value = formatPercent(gainValue);
      }
      return;
    }

    if (inputKey === 'masterVolume') {
      masterVolume = Math.min(1, Math.max(0, Number((target as HTMLInputElement).value)));
      sequencer.setMasterVolume(masterVolume);
      saveMasterVolume(masterVolume);
      const output = (target as HTMLElement).closest('label')?.querySelector<HTMLOutputElement>('[data-role="master-output"]');
      if (output) {
        output.value = formatPercent(masterVolume);
      }
      syncHighVolumeWarning();
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
      const segment = selectedSegmentOrNull();
      if (!segment) {
        return;
      }
      const maxSeconds = segmentOverrideSpanSeconds(segment);
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

    // File import for saved sessions
    if (target instanceof HTMLInputElement && target.dataset.action === 'import-saved-sessions' && target.files?.[0]) {
      const file = target.files[0];
      try {
        const json = await file.text();
        const count = importSavedSessions(json);
        savedSessions = loadSavedSessions();
        if (count > 0) {
          showToast(`Imported ${count} session${count === 1 ? '' : 's'}`);
        } else {
          showToast('No new sessions to import');
        }
        renderLayout();
      } catch {
        showToast('Invalid session file');
      }
      target.value = '';
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

    if (inputKey === 'visualizer-module' && target instanceof HTMLSelectElement) {
      activeVisualizerId = target.value;
      if (visualizerPixiFailed) {
        resetVisualizerRenderer();
      }
      syncVisualizerCanvas();
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
      const segment = selectedSegmentOrNull();
      if (!segment) {
        return;
      }
      const baseValue = segmentStartValueForOverrideTarget(
        segment,
        nextTarget,
      );
      upsertSelectedSegmentOverrideLane(target.dataset.laneId, (lane) => ({
        ...lane,
        target: nextTarget,
        label: describeSegmentOverrideTarget(
          segment,
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
      const segment = selectedSegmentOrNull();
      if (!segment) {
        return;
      }
      const maxSeconds = segmentOverrideSpanSeconds(segment);
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

    // Close session menu on outside click
    if (sessionMenuOpen && !target.closest('[data-role="session-switcher"]')) {
      closeSessionMenu();
    }

    const actionTarget = target.closest<HTMLElement>('[data-action]');
    if (!actionTarget) {
      if (
        playbackMode === 'timeline' &&
        timelineUI.selectedSegmentId !== null &&
        target.closest('[data-role="timeline-canvas"]') &&
        !target.closest('[data-clip-id]')
      ) {
        ensureTimelineUI({
          selectedSegmentId: null,
          selectedPairId: null,
          selectedLaneId: null,
          selectedKeyframeId: null,
        });
        syncSequencerPlaybackTarget();
        renderLayout();
        persistAppState();
      }
      return;
    }

    const action = actionTarget.dataset.action;
    if (!action) {
      return;
    }

    if (action === 'cycle-theme') {
      cycleTheme();
      renderLayout();
      return;
    }

    if (action === 'share-link') {
      persistAppState();

      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(window.location.href);
          shareButtonLabel = 'Link copied';
          showToast('Link copied to clipboard');
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

    if (action === 'dismiss-high-volume-warning') {
      highVolumeWarningDismissed = true;
      markHighVolumeWarningSeen();
      syncHighVolumeWarning();
      return;
    }

    // --- Catalog / session-switcher actions ---

    if (action === 'toggle-session-menu') {
      sessionMenuOpen = !sessionMenuOpen;
      syncSessionMenu();
      return;
    }

    if (action === 'select-catalog-entry') {
      const catalogId = actionTarget.dataset.catalogId;
      if (!catalogId) return;
      closeSessionMenu();
      if (playbackMode === 'catalog') {
        // From landing screen — load directly, no confirm needed
        loadCatalogSession(catalogId);
        return;
      }
      const entry = getCatalogEntry(catalogId);
      if (!entry) return;
      pendingConfirmLabel = entry.label;
      pendingConfirmCatalogId = entry.id;
      pendingConfirmSavedId = null;
      syncConfirmDialog();
      return;
    }

    if (action === 'create-new-session') {
      sequencer.stop();
      const nextSession = createSessionDefinition();
      activeCatalogId = null;
      activeSavedId = null;
      playbackMode = 'timeline';
      replaceSession(nextSession, { rerender: false });
      ensureTimelineUI({ tab: 'timeline', composerModalOpen: true }, nextSession);
      document.body.classList.add('modal-open');
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'return-to-session') {
      playbackMode = 'visualizer';
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'select-saved-session') {
      const savedId = actionTarget.dataset.savedId;
      if (!savedId) return;
      closeSessionMenu();
      if (playbackMode === 'catalog') {
        loadSavedSessionById(savedId);
        return;
      }
      const saved = savedSessions.find((s) => s.id === savedId);
      if (!saved) return;
      pendingConfirmLabel = saved.label;
      pendingConfirmCatalogId = null;
      pendingConfirmSavedId = saved.id;
      syncConfirmDialog();
      return;
    }

    if (action === 'save-current-session') {
      closeSessionMenu();
      if (activeSavedId) {
        updateSavedSession(activeSavedId, session);
        showToast('Session updated');
      } else {
        const saved = saveSessionToLibrary(session);
        activeSavedId = saved.id;
        activeCatalogId = null;
        showToast('Session saved');
      }
      savedSessions = loadSavedSessions();
      return;
    }

    if (action === 'show-catalog') {
      closeSessionMenu();
      playbackMode = 'catalog';
      renderLayout();
      return;
    }

    if (action === 'delete-saved-session') {
      const savedId = actionTarget.dataset.savedId;
      if (!savedId) return;
      deleteSavedSession(savedId);
      savedSessions = loadSavedSessions();
      if (activeSavedId === savedId) {
        activeSavedId = null;
      }
      renderLayout();
      return;
    }

    if (action === 'export-saved-sessions') {
      const json = exportSavedSessions();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'neurotone-sessions.json';
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (action === 'confirm-load-catalog') {
      const catalogId = actionTarget.dataset.catalogId;
      if (!catalogId) return;
      clearConfirmDialog();
      loadCatalogSession(catalogId);
      return;
    }

    if (action === 'confirm-load-saved') {
      const savedId = actionTarget.dataset.savedId;
      if (!savedId) return;
      clearConfirmDialog();
      loadSavedSessionById(savedId);
      return;
    }

    if (action === 'close-confirm-dialog') {
      clearConfirmDialog();
      return;
    }

    if (action === 'set-playback-mode' && actionTarget.dataset.mode) {
      const nextMode = actionTarget.dataset.mode as PlaybackMode;
      if (nextMode === playbackMode) {
        return;
      }

      if (playbackMode === 'analysis' && engineState.playbackState === 'running') {
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
      } else {
        ensureTimelineUI({
          composerModalOpen: false,
        });
      }
      syncSequencerPlaybackTarget();
      revealedChipActionsSegmentId = null;
      pendingRemoveSegmentId = null;
      renderLayout();
      persistAppState();
      if (nextMode === 'visualizer' && activePlaybackState().status !== 'playing') {
        startVisualizerDecay();
      }
      return;
    }

    if (action === 'enter-analysis-mode') {
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
      await sequencer.stop();
      playbackMode = 'analysis';
      ensureTimelineUI({
        selectedSegmentId: selected.id,
        segmentLoopOnly: false,
      });
      manualDiagnosticsOpen = false;
      syncSequencerPlaybackTarget();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'return-to-timeline') {
      if (engineState.playbackState === 'running') {
        await stopManual();
      }
      playbackMode = 'timeline';
      ensureTimelineUI(
        {
          tab: 'timeline',
          composerModalOpen: false,
        },
        session,
      );
      syncSequencerPlaybackTarget();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'open-composer-modal') {
      composerModalTrigger = document.activeElement as HTMLElement | null;
      ensureTimelineUI({
        composerModalOpen: true,
      });
      document.body.classList.add('modal-open');
      renderLayout();
      const dialog = root.querySelector<HTMLElement>('[role="dialog"]');
      dialog?.focus();
      persistAppState();
      return;
    }

    if (action === 'close-composer-modal') {
      ensureTimelineUI({
        composerModalOpen: false,
      });
      document.body.classList.remove('modal-open');
      composerModalTrigger?.focus();
      composerModalTrigger = null;
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

    if (action === 'set-manual-diagnostics-tab' && actionTarget.dataset.tab) {
      const nextTab = actionTarget.dataset.tab as ManualDiagnosticsTab;
      if (
        nextTab === 'beat-map' ||
        nextTab === 'envelope' ||
        nextTab === 'metrics'
      ) {
        manualDiagnosticsTab = nextTab;
        renderLayout();
      }
      return;
    }

    if (action === 'toggle-manual-diagnostics') {
      manualDiagnosticsOpen = !manualDiagnosticsOpen;
      renderLayout();
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
      stopVisualizerDecay();
      clearTimelineDragState();
      syncSequencerPlaybackTarget();
      await sequencer.play();
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'visualizer-play') {
      stopVisualizerDecay();
      syncSequencerPlaybackTarget();
      if (activePlaybackState().status === 'paused') {
        await sequencer.resume();
      } else {
        await sequencer.play();
      }
      syncEngineSnapshot();
      syncHeader();
      syncVisualizerTransport();
      persistAppState();
      return;
    }

    if (action === 'visualizer-pause') {
      await sequencer.pause();
      syncEngineSnapshot();
      syncHeader();
      syncVisualizerTransport();
      persistAppState();
      startVisualizerDecay();
      return;
    }

    if (action === 'pause-timeline') {
      await sequencer.pause();
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      if (playbackMode === 'visualizer') {
        startVisualizerDecay();
      }
      return;
    }

    if (action === 'resume-timeline') {
      stopVisualizerDecay();
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
      if (playbackMode === 'visualizer') {
        startVisualizerDecay();
      }
      return;
    }

    if (action === 'jump-selected') {
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
      pendingRemoveSegmentId = null;
      sequencer.seekToSegment(selectedSegmentIndex());
      syncEngineSnapshot();
      renderLayout();
      ensureTimelineSegmentVisible(selected.id, 'smooth');
      persistAppState();
      return;
    }

    if (action === 'select-segment-override-lane' && actionTarget.dataset.laneId) {
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
      const lane = selected.overrides.find(
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

    if (action === 'toggle-segment-loop-only') {
      if (!timelineUI.selectedSegmentId) {
        return;
      }
      const nextSegmentLoopOnly = !timelineUI.segmentLoopOnly;
      ensureTimelineUI({
        segmentLoopOnly: nextSegmentLoopOnly,
      });
      syncSequencerPlaybackTarget();
      if (nextSegmentLoopOnly) {
        sequencer.seekToSegment(selectedSegmentIndex());
      }
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
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
      if (!scrollContainer || availableWidth <= 0) {
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
        document.body.classList.remove('modal-open');
        replaceSession(plan.session, {
          preserveWorkspace: false,
          tab: 'timeline',
          inspectorTab: 'segment',
          selectedSegmentId: plan.session.segments[0]?.id ?? null,
          selectedPairId: plan.session.segments[0]?.state.pairs[0]?.id ?? null,
          composerModalOpen: false,
        });
        showToast('Timeline generated');
      } catch (error) {
        composerExplanation = [
          error instanceof Error
            ? error.message
            : 'Could not generate a timeline from that input yet.',
        ];
        syncComposerOutput();
        showToast('Could not generate timeline');
      }
      persistAppState();
      return;
    }

    if (action === 'clear-segment-selection') {
      if (timelineUI.selectedSegmentId === null) {
        return;
      }

      revealedChipActionsSegmentId = null;
      pendingRemoveSegmentId = null;
      ensureTimelineUI({
        selectedSegmentId: null,
        selectedPairId: null,
        selectedLaneId: null,
        selectedKeyframeId: null,
      });
      syncSequencerPlaybackTarget();
      renderLayout();
      persistAppState();
      return;
    }

    if (action === 'select-segment' && actionTarget.dataset.segmentId) {
      const nextSegmentId = actionTarget.dataset.segmentId;
      const clearSelection = timelineUI.selectedSegmentId === nextSegmentId;
      if (lastPointerType === 'touch' || lastPointerType === 'pen') {
        revealedChipActionsSegmentId = clearSelection ? null : nextSegmentId;
      } else {
        revealedChipActionsSegmentId = null;
      }
      if (pendingRemoveSegmentId && pendingRemoveSegmentId !== nextSegmentId) {
        pendingRemoveSegmentId = null;
      }
      ensureTimelineUI(
        clearSelection
          ? {
              selectedSegmentId: null,
              selectedPairId: null,
              selectedLaneId: null,
              selectedKeyframeId: null,
            }
          : {
              selectedSegmentId: nextSegmentId,
            },
      );
      syncSequencerPlaybackTarget();
      if (
        !clearSelection &&
        activePlaybackState().status !== 'playing' &&
        engineState.playbackState !== 'running'
      ) {
        applySelectedSegmentToEngine();
      }
      renderLayout();
      if (!clearSelection) {
        ensureTimelineSegmentVisible(nextSegmentId, 'smooth');
      }
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
      const nextSegmentId = actionTarget.dataset.segmentId;
      ensureTimelineUI({
        selectedSegmentId: nextSegmentId,
      });
      revealedChipActionsSegmentId = nextSegmentId;
      if (pendingRemoveSegmentId && pendingRemoveSegmentId !== nextSegmentId) {
        pendingRemoveSegmentId = null;
      }
      syncSequencerPlaybackTarget();
      sequencer.seekToSegment(selectedSegmentIndex());
      syncEngineSnapshot();
      renderLayout();
      ensureTimelineSegmentVisible(nextSegmentId, 'smooth');
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
        label: 'New segment',
        holdDuration: baseSegment.holdDuration,
        transitionDuration: baseSegment.transitionDuration,
        state: createBlankSegmentStateFrom(baseSegment),
        overrides: [],
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
      revealedChipActionsSegmentId = nextSegment.id;
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
        overrides: cloneSegmentOverrides(sourceSegment),
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
      revealedChipActionsSegmentId = nextSegment.id;
      return;
    }

    if (
      action === 'request-remove-segment' &&
      actionTarget.dataset.segmentId &&
      session.segments.length > 1
    ) {
      pendingRemoveSegmentId = actionTarget.dataset.segmentId;
      revealedChipActionsSegmentId = actionTarget.dataset.segmentId;
      renderLayout();
      ensureTimelineSegmentVisible(actionTarget.dataset.segmentId, 'smooth');
      persistAppState();
      return;
    }

    if (
      action === 'cancel-remove-segment' &&
      actionTarget.dataset.segmentId
    ) {
      if (pendingRemoveSegmentId === actionTarget.dataset.segmentId) {
        pendingRemoveSegmentId = null;
      }
      renderLayout();
      persistAppState();
      return;
    }

    if (
      action === 'confirm-remove-segment' &&
      actionTarget.dataset.segmentId &&
      session.segments.length > 1
    ) {
      const remaining = session.segments.filter((segment) => segment.id !== actionTarget.dataset.segmentId);
      const nextSelectedId =
        timelineUI.selectedSegmentId === actionTarget.dataset.segmentId
          ? remaining[0]?.id ?? null
          : timelineUI.selectedSegmentId;
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: remaining,
        }),
        {
          selectedSegmentId: nextSelectedId,
        },
      );
      pendingRemoveSegmentId = null;
      revealedChipActionsSegmentId = nextSelectedId;
      return;
    }

    if (action === 'add-pair') {
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
      const { pair, pairs } = addTonePair(selectedState().pairs, {
        carrierHz: 200,
        beatHz: 10,
        gain: 0.75,
      });
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: session.segments.map((segment) =>
            segment.id === selected.id
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
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
      const nextPairs = removeTonePair(
        selectedState().pairs,
        actionTarget.dataset.pairId,
      );
      replaceSession(
        createSessionDefinition({
          ...session,
          segments: session.segments.map((segment) =>
            segment.id === selected.id
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
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
      const targets = collectSegmentOverrideTargets(selected);
      const defaultTarget = targets[0] ?? 'gain';
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
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
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
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
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
      const selected = selectedSegmentOrNull();
      if (!selected) {
        return;
      }
      const lane = selected.overrides.find(
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
            segment.id === selected.id
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

  window.addEventListener('keydown', async (event) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    const isEditing =
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      (document.activeElement as HTMLElement)?.isContentEditable;

    // Tab trapping inside composer modal
    if (event.key === 'Tab' && timelineUI.composerModalOpen) {
      const dialog = root.querySelector<HTMLElement>('[role="dialog"]');
      if (dialog) {
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length > 0) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
      return;
    }

    // Escape: close session menu / confirm dialog / modal / stop playback
    if (event.key === 'Escape') {
      if (sessionMenuOpen) {
        closeSessionMenu();
        return;
      }
      if (pendingConfirmLabel) {
        clearConfirmDialog();
        return;
      }
      if (playbackMode === 'timeline' && timelineUI.composerModalOpen) {
        ensureTimelineUI({ composerModalOpen: false });
        document.body.classList.remove('modal-open');
        composerModalTrigger?.focus();
        composerModalTrigger = null;
        renderLayout();
        persistAppState();
        return;
      }
      const status = activePlaybackState().status;
      if (status === 'playing' || status === 'paused') {
        await sequencer.stop();
        syncEngineSnapshot();
        renderLayout();
        persistAppState();
        if (playbackMode === 'visualizer') {
          startVisualizerDecay();
        }
        return;
      }
    }

    if (isEditing) return;

    // Space: toggle play/pause
    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      if (playbackMode === 'analysis') return;
      const status = activePlaybackState().status;
      if (status === 'playing') {
        await sequencer.pause();
        if (playbackMode === 'visualizer') {
          startVisualizerDecay();
        }
      } else if (status === 'paused') {
        stopVisualizerDecay();
        await sequencer.resume();
      } else {
        stopVisualizerDecay();
        syncSequencerPlaybackTarget();
        await sequencer.play();
      }
      syncEngineSnapshot();
      renderLayout();
      persistAppState();
      return;
    }

    // Arrow keys: segment navigation in timeline mode
    if (
      playbackMode === 'timeline' &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      const segments = session.segments;
      if (segments.length === 0) return;
      const currentIdx = segments.findIndex(
        (s) => s.id === timelineUI.selectedSegmentId,
      );
      let nextIdx: number;
      if (event.key === 'ArrowLeft') {
        nextIdx = currentIdx <= 0 ? segments.length - 1 : currentIdx - 1;
      } else {
        nextIdx =
          currentIdx >= segments.length - 1 ? 0 : currentIdx + 1;
      }
      ensureTimelineUI({ selectedSegmentId: segments[nextIdx].id });
      renderLayout();
      persistAppState();
      return;
    }
  });

  window.addEventListener('resize', () => {
    syncDiagnostics();
    syncTimelineChipActionOverlayPosition();
  });
}
