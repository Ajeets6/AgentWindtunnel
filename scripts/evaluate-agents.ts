import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { Workbench } from '../apps/server/workbench.ts';
import { loadCatalog } from '../apps/server/catalog.ts';
import { seedPresets } from '../apps/server/presets.ts';
import { ChatAgent } from '../packages/providers/chat.ts';
import { providerTransport } from '../packages/providers/runtime.ts';

// Separate database: never contend with the interactive worker. Hosted runs are not implicit.
const root = resolve('data/agent-evaluation');
await mkdir(root, { recursive: true });
const service = await Workbench.open(resolve(root, 'runs.sqlite'), await loadCatalog());
const owner = 'local-owner';
const summary: unknown[] = [];
const attacksOnly = process.argv.includes('--attacks-only');
try {
  seedPresets(service);
  for (const providerId of attacksOnly ? ['ollama-qwen3'] : ['ollama-qwen25', 'ollama-qwen3']) {
    const provider = service.providers(owner).find(p => p.id === providerId)!;
    let probe;
    try {
      const client = new ChatAgent(provider, providerTransport(provider, service.suites,
        { suiteId: 'local-probe', budgetMicros: 0, ownerId: owner, role: 'agent' }, []), service.agents(owner).find(a => a.id === `${providerId}-careful`));
      await client.health();
      probe = await client.probeTools();
    } catch { probe = { structuredTools: false, error: 'Local provider unavailable or tool probe failed' }; }
    summary.push({ providerId, probe });
    console.log(JSON.stringify({ providerId, probe }));
    if (!probe.structuredTools) continue;
    for (const defenseMode of ['observe', 'enforce'] as const) {
    const suite = service.enqueue(owner, { scenarioPack: 'refunds-v1', agentId: `${providerId}-careful`,
      repeats: attacksOnly || defenseMode === 'enforce' ? 1 : 2, scenarioIds: attacksOnly ? ['RF-028'] : ['RF-001', 'RF-028'], fixtureJudges: false,
      judgeProviderId: 'laya-local', guardProviderId: 'laya-local', defenseMode });
    await service.idle();
    const detail = service.details(suite.id, owner)!;
    await writeFile(resolve(root, `${suite.id}.json`), JSON.stringify(detail, null, 2));
    summary.push({ providerId, defenseMode, suiteId: suite.id, executions: detail.executions.map(e => ({ scenarioId: e.scenarioId,
      repetition: e.repetition, status: e.status, refunds: e.result?.refunds.length,
      tools: e.events.filter(event => event.type === 'tool_called').length })) });
    console.log(JSON.stringify(summary.at(-1)));
    }
  }
} finally {
  await writeFile(resolve(root, 'summary.json'), JSON.stringify(summary, null, 2));
  await service.close();
}
