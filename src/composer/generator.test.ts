import { describe, expect, it } from 'vitest';

import { generateSessionPlan } from './generator';

describe('generateSessionPlan', () => {
  it('creates an editable session timeline from note and chord input', () => {
    const plan = generateSessionPlan({
      label: 'Alpha climb',
      source: 'A3 C#4 E4 Am',
      stepDuration: 6,
      intent: 'alpha',
    });

    expect(plan.session.label).toBe('Alpha climb');
    expect(plan.session.segments).toHaveLength(4);
    expect(plan.session.automationLanes).toHaveLength(0);
    expect(plan.session.segments[0]?.overrides).toEqual([]);
    expect(plan.session.segments[3]?.state.pairs.length).toBeGreaterThan(1);
  });

  it('changes beat strategy with the selected intent', () => {
    const alpha = generateSessionPlan({
      label: 'Alpha',
      source: 'A3',
      stepDuration: 8,
      intent: 'alpha',
    });
    const beta = generateSessionPlan({
      label: 'Beta',
      source: 'A3',
      stepDuration: 8,
      intent: 'beta',
    });

    expect(alpha.session.segments[0]?.state.pairs[0]?.beatHz).toBeLessThan(
      beta.session.segments[0]?.state.pairs[0]?.beatHz ?? 0,
    );
  });
});
