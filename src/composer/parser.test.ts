import { describe, expect, it } from 'vitest';

import { parseCompositionSource } from './parser';

describe('parseCompositionSource', () => {
  it('parses note and chord tokens with duration modifiers', () => {
    const steps = parseCompositionSource('A3 C#4x2 Fmaj7/2');

    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({
      type: 'note',
      label: 'A3',
      durationMultiplier: 1,
    });
    expect(steps[1]).toMatchObject({
      type: 'note',
      label: 'C#4',
      durationMultiplier: 2,
    });
    expect(steps[2]).toMatchObject({
      type: 'chord',
      label: 'Fmaj7',
      durationMultiplier: 0.5,
    });
    expect(steps[2]?.frequencies.length).toBe(4);
  });

  it('ignores invalid tokens instead of crashing', () => {
    const steps = parseCompositionSource('bad-token H2 C4');

    expect(steps).toHaveLength(1);
    expect(steps[0]?.label).toBe('C4');
  });
});

