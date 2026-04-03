import type { SessionDefinition } from './sequencer/types';

export const TIMELINE_WORKSPACE_STORAGE_KEY =
  'neurotone.timeline-workspace.v1';

export type TimelineWorkspaceTab = 'compose' | 'timeline' | 'advanced';

export type TimelineInspectorTab = 'segment' | 'layers' | 'support';

export type AnalysisDockTab = 'envelope' | 'beat-map' | 'metrics';

export interface TimelineWorkspaceUIState {
  tab: TimelineWorkspaceTab;
  composerModalOpen: boolean;
  inspectorTab: TimelineInspectorTab;
  selectedSegmentId: string | null;
  selectedPairId: string | null;
  zoomLevel: number;
  viewportLeft: number;
  selectedLaneId: string | null;
  selectedKeyframeId: string | null;
  analysisDockOpen: boolean;
  analysisDockTab: AnalysisDockTab;
  advancedZoomLevel: number;
  advancedViewportLeft: number;
}

function prefersEditStage(session: SessionDefinition): boolean {
  return (
    session.segments.length > 1 ||
    session.metadata?.source === 'generated' ||
    session.segments.some((segment) => (segment.overrides?.length ?? 0) > 0)
  );
}

export function hasExistingTimeline(session: SessionDefinition): boolean {
  return prefersEditStage(session);
}

export function defaultTimelineWorkspaceTab(
  session: SessionDefinition,
): TimelineWorkspaceTab {
  return prefersEditStage(session) ? 'timeline' : 'compose';
}

export function normalizeTimelineWorkspaceUIState(
  input: Partial<TimelineWorkspaceUIState> | null | undefined,
  session: SessionDefinition,
): TimelineWorkspaceUIState {
  const validSegmentIds = new Set(session.segments.map((segment) => segment.id));
  const nextComposerModalOpen =
    typeof input?.composerModalOpen === 'boolean'
      ? input.composerModalOpen
      : !prefersEditStage(session);

  const normalizedSelectedSegmentId =
    input?.selectedSegmentId && validSegmentIds.has(input.selectedSegmentId)
      ? input.selectedSegmentId
      : session.segments[0]?.id ?? null;
  const selectedSegment =
    session.segments.find((segment) => segment.id === normalizedSelectedSegmentId) ??
    session.segments[0];
  const validPairIds = new Set(
    selectedSegment?.state.pairs.map((pair) => pair.id) ?? [],
  );
  const segmentOverrideLanes = selectedSegment?.overrides ?? [];
  const validLaneIds = new Set(segmentOverrideLanes.map((lane) => lane.id));
  const normalizedSelectedLaneId =
    input?.selectedLaneId && validLaneIds.has(input.selectedLaneId)
      ? input.selectedLaneId
      : segmentOverrideLanes[0]?.id ?? null;
  const selectedLane =
    segmentOverrideLanes.find((lane) => lane.id === normalizedSelectedLaneId) ??
    segmentOverrideLanes[0];
  const validKeyframeIds = new Set(selectedLane?.keyframes.map((keyframe) => keyframe.id) ?? []);
  const legacyAdvancedTab =
    (input as Partial<{ advancedTab: 'automation' | 'analysis' }> | undefined)
      ?.advancedTab;

  return {
    tab: 'timeline',
    composerModalOpen: nextComposerModalOpen,
    inspectorTab:
      input?.inspectorTab === 'segment'
        ? 'segment'
        : input?.inspectorTab === 'layers'
          ? 'layers'
          : input?.inspectorTab === 'support'
            ? 'support'
            : 'segment',
    selectedSegmentId: normalizedSelectedSegmentId,
    selectedPairId:
      input?.selectedPairId && validPairIds.has(input.selectedPairId)
        ? input.selectedPairId
        : selectedSegment?.state.pairs[0]?.id ?? null,
    zoomLevel:
      typeof input?.zoomLevel === 'number' &&
      Number.isFinite(input.zoomLevel)
        ? Math.min(3, Math.max(0.1, input.zoomLevel))
        : 1,
    viewportLeft:
      typeof input?.viewportLeft === 'number' && Number.isFinite(input.viewportLeft)
        ? Math.max(0, input.viewportLeft)
        : 0,
    selectedLaneId: normalizedSelectedLaneId,
    selectedKeyframeId:
      input?.selectedKeyframeId && validKeyframeIds.has(input.selectedKeyframeId)
        ? input.selectedKeyframeId
        : selectedLane?.keyframes[0]?.id ?? null,
    analysisDockOpen:
      typeof input?.analysisDockOpen === 'boolean'
        ? input.analysisDockOpen
        : false,
    analysisDockTab:
      input?.analysisDockTab === 'beat-map'
        ? 'beat-map'
        : input?.analysisDockTab === 'metrics'
          ? 'metrics'
          : legacyAdvancedTab === 'analysis'
            ? 'envelope'
            : 'envelope',
    advancedZoomLevel:
      typeof input?.advancedZoomLevel === 'number' &&
      Number.isFinite(input.advancedZoomLevel)
        ? Math.min(3, Math.max(0.1, input.advancedZoomLevel))
        : 1,
    advancedViewportLeft:
      typeof input?.advancedViewportLeft === 'number' &&
      Number.isFinite(input.advancedViewportLeft)
        ? Math.max(0, input.advancedViewportLeft)
        : 0,
  };
}

export function loadTimelineWorkspaceUIState(
  session: SessionDefinition,
): TimelineWorkspaceUIState {
  try {
    const rawState = window.localStorage.getItem(TIMELINE_WORKSPACE_STORAGE_KEY);
    if (!rawState) {
      return normalizeTimelineWorkspaceUIState(undefined, session);
    }

    return normalizeTimelineWorkspaceUIState(
      JSON.parse(rawState) as Partial<TimelineWorkspaceUIState>,
      session,
    );
  } catch {
    return normalizeTimelineWorkspaceUIState(undefined, session);
  }
}

export function saveTimelineWorkspaceUIState(
  state: TimelineWorkspaceUIState,
  session: SessionDefinition,
): void {
  try {
    window.localStorage.setItem(
      TIMELINE_WORKSPACE_STORAGE_KEY,
      JSON.stringify(normalizeTimelineWorkspaceUIState(state, session)),
    );
  } catch {
    // Fails silently for blocked storage or quota issues.
  }
}
