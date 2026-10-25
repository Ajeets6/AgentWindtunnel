import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { safeTransport } from '../packages/providers/transport.ts';
import { IsolationBoundary } from '../packages/security/isolation.ts';
import { approveEndpoint } from '../packages/providers/egress.ts';

async function server(t: test.TestContext, handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  return `http://127.0.0.1:${address.port}`;
}

test('real pinned transport reaches only an approved loopback socket and parses bounded JSON', async t => {
  let seen = '';
  const url = await server(t, (request, response) => {
    request.on('data', chunk => { seen += String(chunk); });
    request.on('end', () => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true })); });
  });
  const send = safeTransport({ mode: 'local', approved: [url], timeoutMs: 1000 });
  assert.deepEqual(await send({ url, body: { synthetic: true } }), { ok: true });
  assert.equal(JSON.parse(seen).synthetic, true);
  await assert.rejects(send({ url: url.replace('127.0.0.1', 'localhost') }), /not approved/);
});

test('redirects, compressed responses, excess bytes and hanging peers fail closed', async t => {
  const url = await server(t, (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'http://127.0.0.1:22' }); response.end(); }
    if (request.url === '/compressed') { response.writeHead(200, { 'Content-Encoding': 'gzip' }); response.end('not accepted'); }
    if (request.url === '/large') response.end('x'.repeat(200));
  });
  const send = safeTransport({ mode: 'local', approved: [url], timeoutMs: 150, maxBytes: 100 });
  for (const path of ['/redirect', '/compressed', '/large', '/timeout']) await assert.rejects(send({ url: url + path }));
});

test('long evidence cannot be called safe after partial coverage and retains its exact original', async () => {
  const payload = 'benign '.repeat(12000) + 'malicious tail';
  const boundary = new IsolationBoundary(async () => 'safe');
  const result = await boundary.ingest(payload, 'policy-import', 'workbench');
  assert.equal(result.rawPayload, payload);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.guardCalls, 32);
  assert.equal(boundary.authorizeHostOperation('enable_cloud'), false);
});

test('mapped IPv6, metadata, transition and documentation addresses remain blocked', () => {
  for (const address of ['::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::', '2001:db8::1', '100.100.100.200', '0.0.0.0']) {
    const url = address.includes(':') ? `http://[${address}]:8000` : `http://${address}:8000`;
    assert.equal(approveEndpoint({ url, approved: [url], resolved: [address], mode: 'hybrid' }), false);
  }
});
