import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench } from '../apps/server/workbench.ts';
import { loadCatalog } from '../apps/server/catalog.ts';
import { providerSchema } from '../packages/contracts/providers.ts';
import { ChatAgent } from '../packages/providers/chat.ts';
import { safeTransport } from '../packages/providers/transport.ts';

const directory = await mkdtemp(join(tmpdir(), 'aw-real-model-'));
const service = await Workbench.open(join(directory, 'smoke.sqlite'), await loadCatalog());
try {
  const model = process.env.AW_SMOKE_MODEL ?? 'qwen2.5-coder:7b';
  const provider = providerSchema.parse({ id: 'local-smoke', name: 'Local model smoke', protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434', model, modelRevision: model, roles: ['agent'], contextLimit: 4096, timeoutMs: 60000 });
  const client = new ChatAgent(provider, safeTransport({ mode: 'local', approved: [provider.baseUrl], timeoutMs: 60000 }));
  const health = await client.health();
  service.configureProvider('smoke-owner', { ...provider, modelRevision: health.revision });
  const suite = service.enqueue('smoke-owner', { scenarioPack: 'refunds-v1', agentId: provider.id, repeats: 1,
    scenarioIds: ['RF-001'], fixtureJudges: false });
  await service.idle();
  const detail = service.details(suite.id, 'smoke-owner')!;
  const execution = detail.executions[0];
  const calls = execution?.events.filter(e => e.type === 'tool_called').map(e => e.data);
  console.log(JSON.stringify({ health, suiteStatus: detail.status, runStatus: execution?.status,
    structuredToolCallsObserved: Boolean(calls?.length),
    refunds: execution?.result?.refunds, calls, finalMessage: execution?.finalMessage,
    unresolved: execution?.checks.filter(c => c.status === 'needs_review').map(c => c.id),
    usage: execution?.events.filter(e => e.type === 'inference_usage').map(e => e.data) }, null, 2));
  if (detail.status === 'error' || !execution || execution.status === 'error') process.exitCode = 1;
} finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
