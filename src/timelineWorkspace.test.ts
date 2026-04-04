import { describe, expect, it } from 'vitest';

import {
  defaultTimelineWorkspaceTab,
  hasExistingTimeline,
  normalizeTimelineWorkspaceUIState,
} from './timelineWorkspace';

describe('timeline workspace helpers', () => {
  it('defaults simple manual sessions to compose stage', () => {
    const session = {
      id: 'session-1',
      label: 'Manual session',
      loop: false,
      metadata: {
        source: 'manual' as const,
      },
      segments: [
        {
          id: 'segment-1',
          label: 'Segment 1',
          holdDuration: 12,
          transitionDuration: 0,
          overrides: [],
          state: {
            pairs: [],
            masterGain: 0.22,
            noise: {
              enabled: false,
              volume: 0.05,
              model: 'soft' as const,
            },
          },
        },
      ],
      automationLanes: [],
    };

    expect(defaultTimelineWorkspaceTab(session)).toBe('compose');
    expect(hasExistingTimeline(session)).toBe(false);
  });

  it('defaults generated or multi-segment sessions to edit stage', () => {
    const session = {
      id: 'session-2',
      label: 'Generated session',
      loop: false,
      metadata: {
        source: 'generated' as const,
      },
      segments: [
        {
          id: 'segment-1',
          label: 'A',
          holdDuration: 8,
          transitionDuration: 0,
          overrides: [],
          state: {
            pairs: [],
            masterGain: 0.22,
            noise: {
              enabled: false,
              volume: 0.05,
              model: 'soft' as const,
            },
          },
        },
        {
          id: 'segment-2',
          label: 'B',
          holdDuration: 8,
          transitionDuration: 4,
          overrides: [],
          state: {
            pairs: [],
            masterGain: 0.22,
            noise: {
              enabled: false,
              volume: 0.05,
              model: 'soft' as const,
            },
          },
        },
      ],
      automationLanes: [],
    };

    expect(defaultTimelineWorkspaceTab(session)).toBe('timeline');
    expect(hasExistingTimeline(session)).toBe(true);
  });

  it('normalizes invalid selected segment ids to no selection', () => {
    const session = {
      id: 'session-3',
      label: 'Session',
      loop: false,
      metadata: {
        source: 'manual' as const,
      },
      segments: [
        {
          id: 'segment-1',
          label: 'Segment 1',
          holdDuration: 8,
          transitionDuration: 0,
          overrides: [],
          state: {
            pairs: [],
            masterGain: 0.22,
            noise: {
              enabled: false,
              volume: 0.05,
              model: 'soft' as const,
            },
          },
        },
      ],
      automationLanes: [],
    };

    expect(
      normalizeTimelineWorkspaceUIState(
        {
          tab: 'advanced',
          inspectorTab: 'support',
          advancedTab: 'analysis',
          selectedSegmentId: 'missing',
          selectedPairId: 'missing-pair',
          zoomLevel: 2,
          viewportLeft: 180,
        } as never,
        session,
      ),
    ).toEqual({
      tab: 'timeline',
      composerModalOpen: true,
      segmentLoopOnly: false,
      inspectorTab: 'support',
      selectedSegmentId: null,
      selectedPairId: null,
      zoomLevel: 2,
      viewportLeft: 180,
      selectedLaneId: null,
      selectedKeyframeId: null,
      analysisDockOpen: false,
      analysisDockTab: 'envelope',
      advancedZoomLevel: 1,
      advancedViewportLeft: 0,
    });
  });

  it('maps legacy stage/open state into the new tab model', () => {
    const session = {
      id: 'session-4',
      label: 'Session',
      loop: false,
      metadata: {
        source: 'manual' as const,
      },
      segments: [
        {
          id: 'segment-1',
          label: 'Segment 1',
          holdDuration: 8,
          transitionDuration: 0,
          overrides: [],
          state: {
            pairs: [],
            masterGain: 0.22,
            noise: {
              enabled: false,
              volume: 0.05,
              model: 'soft' as const,
            },
          },
        },
      ],
      automationLanes: [],
    };

    expect(
      normalizeTimelineWorkspaceUIState(
        {
          stage: 'edit',
          advancedOpen: true,
        } as never,
        session,
      ),
    ).toEqual({
      tab: 'timeline',
      composerModalOpen: true,
      segmentLoopOnly: false,
      inspectorTab: 'segment',
      selectedSegmentId: null,
      selectedPairId: null,
      zoomLevel: 1,
      viewportLeft: 0,
      selectedLaneId: null,
      selectedKeyframeId: null,
      analysisDockOpen: false,
      analysisDockTab: 'envelope',
      advancedZoomLevel: 1,
      advancedViewportLeft: 0,
    });
  });

  it('normalizes advanced lane and keyframe ids against custom lanes', () => {
    const session = {
      id: 'session-5',
      label: 'Session',
      loop: false,
      metadata: {
        source: 'generated' as const,
      },
      segments: [
        {
          id: 'segment-1',
          label: 'Segment 1',
          holdDuration: 8,
          transitionDuration: 0,
          overrides: [
            {
              id: 'segment-override',
              label: 'Segment override',
              target: 'masterGain' as const,
              interpolation: 'linear' as const,
              enabled: true,
              keyframes: [{ id: 'segment-keyframe', time: 0, value: 0.2 }],
            },
            {
              id: 'custom-override',
              label: 'Custom override',
              target: 'masterGain' as const,
              interpolation: 'linear' as const,
              enabled: true,
              keyframes: [{ id: 'custom-keyframe', time: 0, value: 0.2 }],
            },
          ],
          state: {
            pairs: [],
            masterGain: 0.22,
            noise: {
              enabled: false,
              volume: 0.05,
              model: 'soft' as const,
            },
          },
        },
      ],
      automationLanes: [],
    };

    expect(
      normalizeTimelineWorkspaceUIState(
        {
          selectedSegmentId: 'segment-1',
          selectedLaneId: 'missing-lane',
          selectedKeyframeId: 'missing-keyframe',
          analysisDockTab: 'metrics',
          advancedZoomLevel: 0.5,
          advancedViewportLeft: 96,
        },
        session,
      ),
    ).toEqual({
      tab: 'timeline',
      composerModalOpen: false,
      segmentLoopOnly: false,
      inspectorTab: 'segment',
      selectedSegmentId: 'segment-1',
      selectedPairId: null,
      zoomLevel: 1,
      viewportLeft: 0,
      selectedLaneId: 'segment-override',
      selectedKeyframeId: 'segment-keyframe',
      analysisDockOpen: false,
      analysisDockTab: 'metrics',
      advancedZoomLevel: 0.5,
      advancedViewportLeft: 96,
    });
  });
});
