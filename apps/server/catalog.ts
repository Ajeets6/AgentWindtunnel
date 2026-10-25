import { readFile, readdir } from 'node:fs/promises';
import { parseScenario } from '../../packages/contracts/scenario.ts';
import type { Scenario } from '../../packages/contracts/scenario.ts';

export async function loadCatalog(): Promise<Scenario[]> {
  const directory = new URL('../../scenarios/refunds/', import.meta.url);
  const scenarios: Scenario[] = [];
  for (const filename of (await readdir(directory)).filter(n => n.endsWith('.json')).sort()) {
    const values: unknown = JSON.parse(await readFile(new URL(filename, directory), 'utf8'));
    if (!Array.isArray(values)) throw new Error('Invalid scenario pack');
    scenarios.push(...values.map(parseScenario));
  }
  if (new Set(scenarios.map(s => s.id)).size !== scenarios.length) throw new Error('Duplicate scenario ID');
  return scenarios;
}
