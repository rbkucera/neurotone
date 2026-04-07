import type { SessionDefinition } from '../sequencer/types';
import softArrival from './sessions/soft-arrival.json';

export interface CatalogEntry {
  id: string;
  label: string;
  description: string;
  session: Partial<SessionDefinition>;
}

export const catalog: CatalogEntry[] = [
  {
    id: 'soft-arrival',
    label: 'Soft Arrival',
    description:
      'A gentle opening with layered carriers, sweeping automation, and surf noise.',
    session: softArrival as unknown as Partial<SessionDefinition>,
  },
];

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return catalog.find((entry) => entry.id === id);
}
