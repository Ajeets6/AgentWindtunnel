import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../packages/runner/runner.ts';
import { ExecutionStore } from '../packages/runner/store.ts';
import { scenarios } from './support/fixtures.ts';
import { ChatAgent } from '../packages/providers/chat.ts';
import { agentSchema } from '../packages/contracts/agent.ts';
import { providerSchema } from '../packages/contracts/providers.ts';
import { Workbench } from '../apps/server/workbench.ts';
import { seedPresets } from '../apps/server/presets.ts';

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'aw-defense-'));
  const store = new ExecutionStore(join(directory, 'runs.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, runner: new Runner(store), directory };
}
test('enforcement screens customer input before any agent or tool dispatch', async t => {
  const { runner } = await setup(t);
  let calls = 0;
  const result = await runner.run(scenarios[0], { defenseMode: 'enforce', guard: async () => 'suspicious',
    agent: async () => { calls++; throw new Error('must not dispatch'); } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'needs_review');
  assert.ok(result.checks.some(c => c.id === 'runtime_defense' && c.status === 'needs_review'));
  assert.equal(result.events.filter(e => e.type === 'tool_called').length, 0);
});
test('observation records detections but still measures the underlying agent behavior', async t => {
  const { runner } = await setup(t);
  const result = await runner.run(scenarios[0], { defenseMode: 'observe', guard: async () => 'suspicious' });
  assert.ok(result.events.some(e => e.type === 'tool_called'));
  assert.ok(result.events.some(e => e.type === 'defense_screened'));
  assert.ok(result.checks.some(c => c.id === 'runtime_defense' && c.status === 'needs_review'));
});
test('tool permissions block hallucinated writes even when the classifier says safe', async t => {
  const { runner } = await setup(t);
  const result = await runner.run(scenarios[0], { allowedTools: ['lookup_order'], guard: async () => 'safe' });
  assert.equal(result.status, 'failed');
  assert.equal(result.refunds.length, 0);
  assert.ok(result.events.some(e => e.type === 'tool_denied'));
});
test('tool proposals are screened before a write commits', async t => {
  const { runner } = await setup(t);
  const result = await runner.run(scenarios[0], { defenseMode: 'enforce',
    guard: async span => span.source === 'tool-proposal' ? 'unavailable' : 'safe' });
  assert.equal(result.refunds.length, 0);
  assert.equal(result.events.filter(e => e.type === 'tool_called').length, 0);
});
test('tool results are screened before they reach a subsequent agent turn', async t => {
  const { runner } = await setup(t);
  let turns = 0;
  const result = await runner.run(scenarios[0], { defenseMode: 'enforce',
    guard: async span => span.source === 'agent-input' && span.text.includes('tool_call_id') ? 'suspicious' : 'safe',
    agent: async () => {
      turns++;
      return { content: '', calls: [{ id: 'lookup-1', tool: 'lookup_order', args: { orderId: 'O-102' } }],
        history: [], usage: { input_tokens: 10, output_tokens: 5 } };
    },
  });
  assert.equal(turns, 1);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.events.filter(e => e.type === 'tool_called').length, 1);
});
test('agent profile controls prompt, sampling and advertised tools', async () => {
  const config = providerSchema.parse({ id: 'local', name: 'local', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    model: 'test', modelRevision: 'test', roles: ['agent'], contextLimit: 8192 });
  const profile = agentSchema.parse({ id: 'reader', name: 'Reader', providerId: 'local', systemPrompt: 'Read orders and escalate refunds to an operator.',
    tools: ['lookup_order'], temperature: 0.7, maxOutputTokens: 1024 });
  let body: any;
  await new ChatAgent(config, async request => { body = request.body; return { choices: [{ message: { content: 'Escalating.' } }],
    usage: { prompt_tokens: 10, completion_tokens: 3 } }; }, profile).next({ scenario: scenarios[0] as any, history: [] });
  assert.equal(body.messages[0].content, profile.systemPrompt);
  assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ['lookup_order']);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.reasoning_effort, 'none');
});
test('presets preserve edits and suites snapshot profiles separately from providers', async t => {
  const { directory } = await setup(t);
  const service = await Workbench.open(join(directory, 'workbench.sqlite'), scenarios as any);
  try {
  seedPresets(service);
  const profile = service.agents('local-owner')[0];
  service.configureAgent('local-owner', { ...profile, systemPrompt: 'Custom trusted system prompt for this agent.' });
  seedPresets(service);
  const suite = service.enqueue('local-owner', { scenarioPack: 'refunds-v1', agentId: profile.id, repeats: 1,
    scenarioIds: [scenarios[0].id], fixtureJudges: false });
  service.configureAgent('local-owner', { ...profile, systemPrompt: 'Another trusted system prompt for future runs.' });
  assert.equal(suite.agentProfile?.systemPrompt, 'Custom trusted system prompt for this agent.');
  service.cancel(suite.id, 'local-owner');
  await service.idle();
  } finally { await service.close(); }
});
test('truncated provider text cannot masquerade as a completed agent answer', async () => {
  const config = providerSchema.parse({ id: 'local', name: 'Local', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:11434',
    model: 'test', modelRevision: 'test', roles: ['agent'], contextLimit: 8192 });
  await assert.rejects(new ChatAgent(config, async () => ({ choices: [{ finish_reason: 'length', message: { content: 'Thinking about tools...' } }],
    usage: { prompt_tokens: 10, completion_tokens: 512 } })).next({ scenario: scenarios[0] as any, history: [] }), /output limit/);
});
