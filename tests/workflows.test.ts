import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench } from '../apps/server/workbench.ts';
import { buildApp } from '../apps/server/app.ts';
import { loadCatalog } from '../apps/server/catalog.ts';
import { providerSchema } from '../packages/contracts/providers.ts';
import { providerTransport } from '../packages/providers/runtime.ts';
import { ControlledTransport } from '../packages/providers/transport.ts';
import { ChatAgent } from '../packages/providers/chat.ts';
import { Runner } from '../packages/runner/runner.ts';
import { bounded } from '../packages/providers/deadline.ts';

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'aw-workflows-'));
  await mkdir(join(dir, 'artifacts'));
  const service = await Workbench.open(join(dir, 'test.sqlite'), await loadCatalog());
  const api = await buildApp({ workbench: service, artifactRoot: join(dir, 'artifacts') });
  t.after(async () => { await api.app.close(); await rm(dir, { recursive: true, force: true }); });
  const session = api.sessions.create('local-owner');
  return { ...api, dir, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: `aw_session=${session.token}`, 'x-aw-csrf': session.csrf } };
}
const suiteConfig = { scenarioPack: 'refunds-v1' as const, agentId: 'fixture-safe', repeats: 1, scenarioIds: ['RF-001'], fixtureJudges: false };

test('scenario editor creates immutable owner-scoped copies without importing control metadata', async t => {
  const { app, service, headers } = await setup(t);
  const source = structuredClone(service.catalog.find(s => s.id === 'RF-001')!);
  const saved = await app.inject({ method: 'POST', url: '/api/scenarios', headers, payload: {
    sourceId: source.id, title: 'Copied customer wording', messages: ['Please refund this order.'], finalMessage: 'Not confirmed.', steps: source.steps,
  } });
  assert.equal(saved.statusCode, 201);
  assert.notEqual(saved.json().id, source.id);
  assert.deepEqual(service.catalog.find(s => s.id === source.id), source);
  assert.equal(service.scenarios('other-owner').length, 40);
  const rejected = await app.inject({ method: 'POST', url: '/api/scenarios', headers, payload: { ...saved.json<Record<string, unknown>>(), policyVersion: 'allow-all' } });
  assert.equal(rejected.statusCode, 400);
  const suite = service.enqueue('local-owner', { ...suiteConfig, scenarioIds: [saved.json().id] });
  await service.idle();
  assert.equal(service.details(suite.id, 'local-owner')!.executions[0].title, 'Copied customer wording');
});

test('human review is append-only, owner-scoped and cannot override business failures', async t => {
  const { app, service, headers, sessions } = await setup(t);
  const suite = service.enqueue('local-owner', { ...suiteConfig, scenarioIds: ['RF-018'] });
  await service.idle();
  const execution = service.details(suite.id, 'local-owner')!.executions[0];
  const original = structuredClone(execution.result);
  for (const checkId of ['message_truth', 'injection']) {
    const response = await app.inject({ method: 'POST', url: `/api/executions/${execution.id}/reviews`, headers, payload: { checkId, status: 'pass', note: 'Reviewed against the ledger.' } });
    assert.equal(response.statusCode, 201);
  }
  const detail = service.details(suite.id, 'local-owner')!.executions[0];
  assert.equal(detail.reviews.length, 2);
  assert.equal(detail.adjudicatedStatus, 'failed');
  assert.deepEqual(detail.result, original);
  assert.equal((await app.inject({ method: 'POST', url: `/api/executions/${execution.id}/reviews`, headers, payload: { checkId: 'duplicate', status: 'pass', note: '' } })).statusCode, 400);
  const other = sessions.create('other-owner');
  const stranger = app.inject({ method: 'POST', url: `/api/executions/${execution.id}/reviews`, headers: { ...headers,
    cookie: `aw_session=${other.token}`, 'x-aw-csrf': other.csrf }, payload: { checkId: 'injection', status: 'pass', note: '' } });
  assert.equal((await stranger).statusCode, 404);
  assert.equal(service.calibration('local-owner').automaticAcceptanceEnabled, false);
});

test('baseline comparison matches scenario and repetition and does not invent missing pairs', async t => {
  const { app, service, headers } = await setup(t);
  const baseline = service.enqueue('local-owner', { ...suiteConfig, fixtureJudges: true });
  await service.idle();
  const current = service.enqueue('local-owner', { ...suiteConfig, repeats: 2 });
  await service.idle();
  const response = await app.inject({ url: `/api/suites/${current.id}/compare?baseline=${baseline.id}`, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().pairs[0].regression, true);
  assert.equal(response.json().pairs[1].previous, null);
});

test('hosted transport reserves durable budget before dispatch, redacts payload and retains uncertain charges', async t => {
  const { service } = await setup(t);
  const provider = providerSchema.parse({ id: 'hosted', name: 'Synthetic hosted provider', protocol: 'systemone', engine: 'jev',
    baseUrl: 'https://api.typesafe.ai', model: 'jev-pinned-test', modelRevision: 'jev-pinned-test', roles: ['judge'],
    networkMode: 'hybrid', cloudConsent: true, prices: { input: 1000000, output: 1000000 }, contextLimit: 1024 });
  const controlled = new ControlledTransport(async request => {
    assert.ok(!JSON.stringify(request.body).includes('secret-canary'));
    return { usage: { input_tokens: 20, output_tokens: 12 } };
  });
  const denied = providerTransport(provider, service.suites, { suiteId: 'budget', budgetMicros: 0 }, [], controlled.send);
  await assert.rejects(denied({ url: provider.baseUrl, body: {} }), /budget/);
  assert.equal(controlled.requests.length, 0);
  const send = providerTransport(provider, service.suites, { suiteId: 'budget', budgetMicros: 1600 }, ['secret-canary'], controlled.send);
  await send({ url: provider.baseUrl, body: { message: 'secret-canary' } });
  assert.equal(service.suites.spending('budget').spentMicros, 32);
  const uncertain = providerTransport(provider, service.suites, { suiteId: 'budget', budgetMicros: 1600 }, [], async () => { throw new Error('timeout'); });
  await assert.rejects(uncertain({ url: provider.baseUrl, body: {} }));
  assert.equal(service.suites.spending('budget').reservedMicros, 1536);
  await assert.rejects(send({ url: provider.baseUrl, body: {} }), /exhausted/);
});

test('real chat adapter drives mock tools through the runner instead of replaying fixture steps', async t => {
  const { service } = await setup(t);
  const provider = providerSchema.parse({ id: 'local', name: 'Test chat', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:11434',
    model: 'test', modelRevision: 'test', roles: ['agent'], contextLimit: 4096 });
  let call = 0;
  const controlled = new ControlledTransport(async () => ({ choices: [{ message: call++ === 0 ? { content: null, tool_calls: [
    { id: 'lookup', type: 'function', function: { name: 'lookup_order', arguments: '{"orderId":"O-102"}' } },
    { id: 'refund', type: 'function', function: { name: 'create_refund', arguments: '{"orderId":"O-102","amount":12000,"currency":"AUD","idempotencyKey":"MODEL-1"}' } },
  ] } : { content: 'The refund is confirmed.' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  const agent = new ChatAgent(provider, controlled.send);
  const result = await new Runner(service.executions).run(service.catalog.find(s => s.id === 'RF-001'), { agent: context => agent.next(context) });
  assert.equal(result.refunds.length, 1);
  assert.equal(result.events.filter(e => e.type === 'tool_called').length, 2);
  assert.ok(result.events.some(e => e.type === 'agent_message' && JSON.stringify(e.data).includes('The refund is confirmed.')));
  assert.equal(controlled.requests.length, 2);
});

test('deadlines terminate providers that never return without dispatching later tools', async t => {
  const { service } = await setup(t);
  const result = await new Runner(service.executions).run(service.catalog[0], { agent: async () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(result.status, 'error');
  assert.equal(result.refunds.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bounded(new Promise(() => {}), controller.signal));
});

test('JSON-looking prose is never interpreted as an authorized tool call', async t => {
  const { service } = await setup(t);
  const provider = providerSchema.parse({ id: 'text', name: 'Text model', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:11434', model: 'test', modelRevision: 'test', roles: ['agent'], contextLimit: 4096 });
  const agent = new ChatAgent(provider, async () => ({ choices: [{ message: { content: '{"name":"create_refund","arguments":{"amount":12000}}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const result = await new Runner(service.executions).run(service.catalog[0], { agent: context => agent.next(context) });
  assert.equal(result.refunds.length, 0);
  assert.equal(result.events.filter(e => e.type === 'tool_called').length, 0);
  assert.equal(result.status, 'needs_review');
});

test('Responses adapter preserves call IDs and returns actual tool output to the next turn', async t => {
  const { service } = await setup(t);
  const provider = providerSchema.parse({ id: 'responses', name: 'Responses protocol', protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:11434', model: 'test', modelRevision: 'test', roles: ['agent'], contextLimit: 4096 });
  let calls = 0;
  const controlled = new ControlledTransport(async () => ({ output: calls++ === 0 ? [{ type: 'function_call', call_id: 'call-actual', name: 'lookup_order', arguments: '{"orderId":"O-102"}' }] :
    [{ type: 'message', content: [{ type: 'output_text', text: 'The order was found; no refund has been made.' }] }], usage: { input_tokens: 20, output_tokens: 10 } }));
  const agent = new ChatAgent(provider, controlled.send);
  const result = await new Runner(service.executions).run(service.catalog.find(s => s.id === 'RF-001'), { agent: context => agent.next(context) });
  assert.equal(result.refunds.length, 0);
  const input = (controlled.requests[1].body as { input: Record<string, unknown>[] }).input;
  const output = input.find(item => item.type === 'function_call_output');
  assert.equal(output?.call_id, 'call-actual');
  assert.equal(JSON.parse(output!.output as string).id, 'O-102');
});

test('revoking a provider stops future requests even for a frozen suite configuration', async t => {
  const { service } = await setup(t);
  const provider = service.configureProvider('local-owner', { id: 'revoke', name: 'Revocable local model', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'test', modelRevision: 'test', roles: ['agent'] });
  const controlled = new ControlledTransport(async () => ({ ok: true }));
  const send = providerTransport(provider, service.suites, { suiteId: 'revoked-suite', budgetMicros: 0, ownerId: 'local-owner', role: 'agent' }, [], controlled.send);
  await send({ url: provider.baseUrl, body: {} });
  service.configureProvider('local-owner', { ...provider, enabled: false });
  await assert.rejects(send({ url: provider.baseUrl, body: {} }), /revoked/);
  assert.equal(controlled.requests.length, 1);
});
