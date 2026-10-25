import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { buildApp } from '../apps/server/app.ts';
import { Workbench } from '../apps/server/workbench.ts';
import { loadCatalog } from '../apps/server/catalog.ts';

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'aw-api-'));
  await mkdir(join(directory, 'artifacts'));
  const services: Awaited<ReturnType<typeof buildApp>>[] = [];
  t.after(async () => {
    for (const service of services) await service.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function open() {
    const workbench = await Workbench.open(join(directory, 'app.sqlite'), await loadCatalog());
    const api = await buildApp({ workbench, artifactRoot: join(directory, 'artifacts') });
    services.push(api);
    const session = api.sessions.create('local-owner');
    const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
      cookie: `aw_session=${session.token}`, 'x-aw-csrf': session.csrf };
    return { ...api, session, headers };
  }
  return { open, directory };
}

test('bootstrap is single-use, sets an HttpOnly cookie, and enforces CSRF on logout', async t => {
  const api = await (await setup(t)).open();
  const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
  const login = await api.app.inject({ method: 'POST', url: '/api/session/bootstrap', headers, payload: { token: api.bootstrapToken } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const proof = login.json().csrf;
  const authenticated = { ...headers, cookie: cookie.split(';')[0] };
  assert.equal((await api.app.inject({ method: 'GET', url: '/api/session', headers: authenticated })).statusCode, 200);
  assert.equal((await api.app.inject({ method: 'POST', url: '/api/session/bootstrap', headers, payload: { token: api.bootstrapToken } })).statusCode, 401);
  assert.equal((await api.app.inject({ method: 'DELETE', url: '/api/session', headers: authenticated })).statusCode, 403);
  assert.equal((await api.app.inject({ method: 'DELETE', url: '/api/session', headers: { ...authenticated, 'x-aw-csrf': proof } })).statusCode, 200);
  assert.equal((await api.app.inject({ method: 'GET', url: '/api/session', headers: authenticated })).statusCode, 401);
});

test('API launches actual runner work and exposes independent snapshots and exports', async t => {
  const { app, service, headers } = await (await setup(t)).open();
  const launched = await app.inject({ method: 'POST', url: '/api/suites', headers,
    payload: { scenarioPack: 'refunds-v1', agentId: 'fixture-safe', scenarioIds: ['RF-001', 'RF-018'], repeats: 2, fixtureJudges: true } });
  assert.equal(launched.statusCode, 202);
  const id = launched.json().id;
  await service.idle();
  const detail = (await app.inject({ url: `/api/suites/${id}`, headers })).json();
  assert.equal(detail.status, 'completed');
  assert.equal(detail.executions.length, 4);
  assert.equal(new Set(detail.executions.map((e: { id: string }) => e.id)).size, 4);
  for (const item of detail.executions) {
    assert.equal(item.before.orders[0].refunded, 0);
    assert.equal(item.after.orders[0].refunded, item.scenarioId === 'RF-018' ? 24000 : 12000);
    assert.equal(item.status, item.scenarioId === 'RF-018' ? 'failed' : 'passed');
  }
  const xml = await app.inject({ url: `/api/suites/${id}/export?format=junit`, headers });
  assert.equal(xml.statusCode, 200);
  assert.ok(xml.body.includes('failures="2"'));
  const stranger = service.suites.get(id, 'other-owner');
  assert.equal(stranger, undefined);
});

test('queued cancellation prevents tool dispatch and restart resumes incomplete suites', async t => {
  const { open } = await setup(t);
  const first = await open();
  const cancelled = first.service.enqueue('local-owner', { scenarioPack: 'refunds-v1', agentId: 'fixture-safe',
    repeats: 1, scenarioIds: ['RF-001'], fixtureJudges: false });
  first.service.cancel(cancelled.id, 'local-owner');
  await first.service.idle();
  const cancelledSuite = first.service.suites.get(cancelled.id, 'local-owner')!;
  assert.equal(cancelledSuite.status, 'cancelled');
  assert.equal(cancelledSuite.executions.length, 0);
  const pending = first.service.enqueue('local-owner', { scenarioPack: 'refunds-v1', agentId: 'fixture-safe',
    repeats: 3, scenarioIds: ['RF-017'], fixtureJudges: true });
  await first.app.close();
  const second = await open();
  second.service.kick();
  await second.service.idle();
  const result = second.service.details(pending.id, 'local-owner')!;
  assert.equal(result.status, 'completed');
  assert.equal(result.executions.length, 3);
  assert.ok(result.executions.every(e => e.result?.refunds.length === 1));
});

test('SSE replays durable progress after Last-Event-ID over an actual HTTP connection', async t => {
  const api = await (await setup(t)).open();
  const suite = api.service.enqueue('local-owner', { scenarioPack: 'refunds-v1', agentId: 'fixture-safe',
    repeats: 1, scenarioIds: ['RF-001'], fixtureJudges: true });
  await api.service.idle();
  const events = api.service.suites.events(suite.id);
  assert.ok(events.length >= 3);
  const cursor = events.at(-2)!.id;
  const address = await api.app.listen({ host: '127.0.0.1', port: 0 });
  const response = await new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
    const request = get(`${address}/api/suites/${suite.id}/events`, {
      headers: { ...api.headers, host: new URL(address).host, origin: address, 'last-event-id': String(cursor) },
    }, response => {
      response.once('data', chunk => {
        resolve({ status: response.statusCode!, type: String(response.headers['content-type']), text: String(chunk) });
        response.destroy();
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('SSE test timed out')));
  });
  assert.equal(response.status, 200);
  assert.match(response.type, /text\/event-stream/);
  const text = response.text;
  assert.ok(text.includes(`id: ${cursor + 1}\n`));
  assert.ok(!text.includes(`id: ${cursor}\n`));
  assert.ok(text.includes('"status":"completed"'));
});
