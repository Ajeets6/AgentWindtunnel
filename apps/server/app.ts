import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { Workbench } from './workbench.ts';
import { equal, parseJson, redact, Sessions, token } from './security.ts';
import { junit, report } from '../../packages/cli/report.ts';
import type { SuiteEvent } from '../../packages/contracts/api.ts';
import { providerSchema } from '../../packages/contracts/providers.ts';
import { ChatAgent } from '../../packages/providers/chat.ts';
import { providerTransport } from '../../packages/providers/runtime.ts';
import { scenarioSchema } from '../../packages/contracts/scenario.ts';

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const suiteInput = z.strictObject({
  scenarioPack: z.literal('refunds-v1'), agentId: z.string().regex(identifier),
  repeats: z.number().int().min(1).max(10),
  scenarioIds: z.array(z.string().regex(identifier)).min(1).max(40).refine(a => new Set(a).size === a.length).optional(),
  fixtureJudges: z.boolean().default(false),
  judgeProviderId: z.string().regex(identifier).optional(), guardProviderId: z.string().regex(identifier).optional(),
  cloudBudgetMicros: z.number().int().min(0).max(10000000).default(0), baselineId: z.string().regex(identifier).optional(),
});
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export async function buildApp(options: {
  workbench: Workbench; origin?: string; artifactRoot: string; webRoot?: string;
}) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, requestTimeout: 15000, routerOptions: { maxParamLength: 256 } });
  function expectedOrigin() {
    const address = app.server.address();
    return options.origin ?? (address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://127.0.0.1:3000');
  }
  const sessions = new Sessions();
  let bootstrapToken = token();
  const service = options.workbench;
  const streams = new Set<import('node:http').ServerResponse>();

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try { done(null, parseJson(body as string)); }
    catch { done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined); }
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = expectedOrigin();
    const host = new URL(origin).host;
    reply.headers({ 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' });
    if (request.headers.host !== host || (request.headers.origin !== undefined && request.headers.origin !== origin))
      return reply.code(403).send({ error: 'Untrusted origin or host' });
    let path: string;
    try { path = decodeURIComponent(request.raw.url!.split('?')[0]); }
    catch { return reply.code(400).send({ error: 'Invalid URL' }); }
    if (path.includes('\\') || path.includes('\0') || path.split('/').some(p => p === '.' || p === '..'))
      return reply.code(400).send({ error: 'Invalid path' });
    if (!path.startsWith('/api/') || path === '/api/session/bootstrap') return;
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
    const cookie = request.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith('aw_session='))?.slice(11);
    const session = sessions.get(bearer ?? cookie ?? '');
    if (!session) return reply.code(401).send({ error: 'Open the local sign-in link printed by the server' });
    request.session = session;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if ((!bearer && request.headers.origin !== origin) || !equal(String(request.headers['x-aw-csrf'] ?? ''), session.csrf))
        return reply.code(403).send({ error: 'CSRF proof required' });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const candidate = (error as { statusCode?: number }).statusCode;
    const status = typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
    reply.code(status).send({ error: status === 413 ? 'Request exceeds 1 MiB' : status === 400 ? 'Invalid request' :
      status === 429 ? 'Queue is full' : 'Request could not be completed', requestId: request.id });
  });
  app.addHook('preSerialization', async (_request, _reply, payload) => redact(payload, service.secrets));

  app.post('/api/session/bootstrap', async (request, reply) => {
    if (request.headers.origin !== expectedOrigin()) return reply.code(403).send({ error: 'Origin required' });
    const parsed = z.strictObject({ token: z.string().max(128) }).safeParse(request.body);
    if (!parsed.success || !bootstrapToken || !equal(parsed.data.token, bootstrapToken))
      return reply.code(401).send({ error: 'Invalid or expired sign-in link' });
    bootstrapToken = '';
    const session = sessions.create('local-owner');
    reply.header('Set-Cookie', `aw_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    return { csrf: session.csrf };
  });
  app.get('/api/session', async request => ({ csrf: request.session!.csrf, networkMode: 'local', agentMode: 'scripted-fixture' }));
  app.delete('/api/session', async (request, reply) => {
    sessions.delete(request.session!.token);
    reply.header('Set-Cookie', 'aw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });
  app.get('/api/scenarios', async request => ({ scenarios: service.scenarios(request.session!.ownerId) }));
  app.post('/api/scenarios', async (request, reply) => {
    const input = z.strictObject({ sourceId: z.string().regex(identifier), title: z.string().min(6).max(200),
      messages: z.array(z.string().max(65536)).min(1).max(100), finalMessage: z.string().max(65536),
      steps: z.array(z.strictObject({ tool: z.string().max(100), args: z.record(z.string(), z.unknown()) })).max(128).optional(),
      initial: scenarioSchema.shape.initial.optional(), faults: scenarioSchema.shape.faults.optional(),
      retryLimit: scenarioSchema.shape.retryLimit.optional(), mockMode: scenarioSchema.shape.mockMode.optional() }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Only explicit scenario copies are accepted; control metadata cannot be imported' });
    const { sourceId, ...edits } = input.data;
    return reply.code(201).send(service.duplicateScenario(request.session!.ownerId, sourceId, edits));
  });
  app.get('/api/agents', async request => ({ agents: [{ id: 'fixture-safe', name: 'Authored fixture agent', kind: 'scripted',
    description: 'Replays authored actions, including deliberate mistakes.' }, ...service.providers(request.session!.ownerId).filter(p => p.enabled && p.roles.includes('agent')).map(p => ({ id: p.id, name: p.name, kind: p.protocol, description: p.model }))] }));
  app.get('/api/settings', async request => ({ providers: service.providers(request.session!.ownerId), semanticJudging: 'Human-gated until held-out calibration is established.' }));
  app.post('/api/providers', async (request, reply) => {
    const input = providerSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues.map(i => i.message).join('; ') });
    return service.configureProvider(request.session!.ownerId, input.data);
  });
  app.post('/api/providers/test', async (request, reply) => {
    const input = z.strictObject({ id: z.string().regex(identifier) }).safeParse(request.body);
    const provider = input.success ? service.providers(request.session!.ownerId).find(p => p.id === input.data.id && p.enabled) : undefined;
    if (!provider) return reply.code(400).send({ error: 'Unknown provider' });
    try {
      const send = providerTransport(provider, service.suites, { suiteId: 'health-' + request.id, budgetMicros: 0, ownerId: request.session!.ownerId }, service.secrets);
      const health = provider.protocol === 'systemone' ? await send({ url: provider.baseUrl + '/health', method: 'GET' }) : await new ChatAgent(provider, send).health();
      if (provider.protocol === 'systemone') z.object({ model_revision: z.literal(provider.modelRevision), tokenizer_revision: z.literal(provider.tokenizerRevision) }).parse(health);
      const capabilities = provider.protocol !== 'systemone' && provider.roles.includes('agent') ? await new ChatAgent(provider, send).probeTools() : { structuredTools: false, reason: 'Not an agent tool probe' };
      service.suites.put(request.session!.ownerId, 'provider-probe', provider.id, { health, capabilities, at: new Date().toISOString() });
      return { ok: true, health, capabilities, automaticAcceptanceEnabled: false };
    } catch { return reply.code(422).send({ error: 'Provider probe failed, lacked budget, or did not match the configured model' }); }
  });
  app.get('/api/reviews', async request => service.calibration(request.session!.ownerId));
  app.post<{ Params: { id: string } }>('/api/executions/:id/reviews', async (request, reply) => {
    const input = z.strictObject({ checkId: z.enum(['message_truth', 'injection']), status: z.enum(['pass', 'fail', 'needs_review']), note: z.string().max(2000) }).safeParse(request.body);
    if (!input.success || !identifier.test(request.params.id)) return reply.code(400).send({ error: 'Invalid semantic review' });
    return reply.code(201).send(service.review(request.session!.ownerId, request.params.id, input.data));
  });
  app.get<{ Params: { id: string }; Querystring: { baseline?: string } }>('/api/suites/:id/compare', async (request, reply) => {
    const current = service.details(request.params.id, request.session!.ownerId);
    const baseline = request.query.baseline && identifier.test(request.query.baseline) ? service.details(request.query.baseline, request.session!.ownerId) : undefined;
    if (!current || !baseline) return reply.code(404).send({ error: 'Owned baseline and suite required' });
    return { baselineId: baseline.id, currentId: current.id, pairs: current.executions.map(execution => {
      const other = baseline.executions.find(e => e.scenarioId === execution.scenarioId && e.repetition === execution.repetition);
      return { scenarioId: execution.scenarioId, repetition: execution.repetition, previous: other?.adjudicatedStatus ?? null,
        current: execution.adjudicatedStatus, regression: other?.adjudicatedStatus === 'passed' && execution.adjudicatedStatus !== 'passed' };
    }) };
  });
  app.get('/api/suites', async request => ({ suites: service.suites.list(request.session!.ownerId)
    .map(({ scenarios, ...suite }) => ({ ...suite, scenarioCount: scenarios.length })) }));
  app.post('/api/suites', async (request, reply) => {
    const input = suiteInput.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid suite configuration' });
    const suite = service.enqueue(request.session!.ownerId, input.data);
    return reply.code(202).send({ id: suite.id });
  });
  function owned(id: string, ownerId: string) {
    if (!identifier.test(id)) throw Object.assign(new Error('Invalid ID'), { statusCode: 400 });
    return service.suites.get(id, ownerId);
  }
  app.get<{ Params: { id: string } }>('/api/suites/:id', async (request, reply) => {
    if (!owned(request.params.id, request.session!.ownerId)) return reply.code(404).send({ error: 'Not found' });
    return service.details(request.params.id, request.session!.ownerId);
  });
  app.post<{ Params: { id: string } }>('/api/suites/:id/cancel', async (request, reply) => {
    if (!owned(request.params.id, request.session!.ownerId)) return reply.code(404).send({ error: 'Not found' });
    service.cancel(request.params.id, request.session!.ownerId);
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/suites/:id/export', async (request, reply) => {
    if (!owned(request.params.id, request.session!.ownerId)) return reply.code(404).send({ error: 'Not found' });
    const details = service.details(request.params.id, request.session!.ownerId)!;
    const format = request.query.format ?? 'json';
    if (!['json', 'junit'].includes(format)) return reply.code(400).send({ error: 'Invalid export format' });
    reply.header('Content-Disposition', `attachment; filename="suite-${details.id}.${format === 'json' ? 'json' : 'xml'}"`);
    if (format === 'json') return details;
    const runs = details.executions.filter(e => e.result).map(e => ({ ...e, result: e.result! }));
    return reply.type('application/xml; charset=utf-8').send(junit(report(runs)));
  });
  app.get<{ Params: { id: string } }>('/api/suites/:id/events', async (request, reply) => {
    const suite = owned(request.params.id, request.session!.ownerId);
    if (!suite) return reply.code(404).send({ error: 'Not found' });
    const afterText = String(request.headers['last-event-id'] ?? '0');
    if (!/^\d{1,10}$/.test(afterText)) return reply.code(400).send({ error: 'Invalid event cursor' });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { ...Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])),
      'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    streams.add(raw);
    const send = (event: SuiteEvent) => {
      if (!raw.destroyed) raw.write(`id: ${event.id}\nevent: progress\ndata: ${JSON.stringify(redact(event.data, service.secrets))}\n\n`);
    };
    service.events.on(suite.id, send);
    for (const event of service.suites.events(suite.id, Number(afterText))) send(event);
    const timer = setInterval(() => {
      if (!sessions.get(request.session!.token)) raw.end();
      else if (!raw.destroyed) raw.write(': heartbeat\n\n');
    }, 15000);
    raw.on('close', () => { clearInterval(timer); service.events.off(suite.id, send); streams.delete(raw); });
  });
  app.get<{ Params: { id: string } }>('/api/executions/:id', async (request, reply) => {
    if (!identifier.test(request.params.id)) return reply.code(400).send({ error: 'Invalid ID' });
    const suite = service.suites.list(request.session!.ownerId).find(s => s.executions.some(e => e.id === request.params.id));
    if (!suite) return reply.code(404).send({ error: 'Not found' });
    return service.details(suite.id, request.session!.ownerId)!.executions.find(e => e.id === request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    if (!identifier.test(request.params.id)) return reply.code(400).send({ error: 'Invalid artifact ID' });
    const filename = service.suites.artifact(request.params.id, request.session!.ownerId);
    if (!filename) return reply.code(404).send({ error: 'Not found' });
    try {
      const root = await realpath(options.artifactRoot);
      const path = await realpath(resolve(root, filename));
      const child = relative(root, path);
      if (!child || child.startsWith('..') || isAbsolute(child) || !(await stat(path)).isFile())
        return reply.code(404).send({ error: 'Not found' });
      if ((await stat(path)).size > 8 * 1024 * 1024) return reply.code(413).send({ error: 'Artifact too large' });
      reply.header('Content-Disposition', `attachment; filename="${request.params.id}.txt"`);
      return reply.type('text/plain; charset=utf-8').send(redact(await readFile(path, 'utf8'), service.secrets));
    } catch { return reply.code(404).send({ error: 'Not found' }); }
  });
  if (options.webRoot) await app.register(staticFiles, { root: options.webRoot, index: ['index.html'], dotfiles: 'deny' });
  else app.get('/', async (_request, reply) => reply.type('text/html').send('<!doctype html><html lang="en"><title>AgentWindTunnel</title><body><main><h1>AgentWindTunnel</h1><p>Build the web workspace with npm run build.</p></main></body></html>'));
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); });
  app.addHook('onClose', async () => { await service.close(); });
  await app.ready();
  return { app, sessions, bootstrapToken, service };
}

declare module 'fastify' {
  interface FastifyRequest { session?: { token: string; ownerId: string; csrf: string; expires: number } }
}
