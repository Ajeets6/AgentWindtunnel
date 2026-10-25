import assert from 'node:assert/strict';
import { contract } from './support/harness.ts';
import type { EndpointInput } from './support/contracts.ts';

const local: EndpointInput = {
  url: 'http://127.0.0.1:8000', mode: 'local', approved: ['http://127.0.0.1:8000'], resolved: ['127.0.0.1']
};
const cases: [string, Partial<EndpointInput>, boolean][] = [
  ['approved loopback', {}, true],
  ['approved IPv6 loopback', { url: 'http://[::1]:8000', approved: ['http://[::1]:8000'], resolved: ['::1'] }, true],
  ['unapproved local port', { url: 'http://127.0.0.1:22' }, false],
  ['cloud in local mode', { url: 'https://api.typesafe.ai', resolved: ['93.184.216.34'] }, false],
  ['LAN in local mode', { url: 'http://192.168.1.4:8000', resolved: ['192.168.1.4'] }, false],
  ['metadata endpoint', { url: 'http://169.254.169.254/latest/meta-data', resolved: ['169.254.169.254'] }, false],
  ['IPv6 link-local', { url: 'http://[fe80::1]:8000', resolved: ['fe80::1'] }, false],
  ['file scheme', { url: 'file:///etc/passwd' }, false],
  ['gopher scheme', { url: 'gopher://127.0.0.1:6379' }, false],
  ['credentials in URL', { url: 'http://user:secret@127.0.0.1:8000' }, false],
  ['loopback suffix spoof', { url: 'http://localhost.attacker.test:8000', resolved: ['93.184.216.34'] }, false],
  ['userinfo spoof', { url: 'http://127.0.0.1:8000@attacker.test', resolved: ['93.184.216.34'] }, false],
  ['redirect off loopback', { redirect: 'https://attacker.test' }, false],
  ['redirect to another local service', { redirect: 'http://127.0.0.1:22' }, false],
  ['DNS answer mixes public and loopback', { url: 'http://localhost:8000', approved: ['http://localhost:8000'], resolved: ['127.0.0.1', '93.184.216.34'] }, false],
  ['DNS rebinding at connect time', { connectedAddress: '93.184.216.34' }, false],
  ['local cloud model alias', { model: 'model:cloud' }, false],
  ['unapproved decimal IP representation', { url: 'http://2130706433:8000' }, false],
  ['approved private LAN', { mode: 'lan', url: 'http://192.168.1.4:8000', approved: ['http://192.168.1.4:8000'], resolved: ['192.168.1.4'] }, true],
  ['LAN mode cannot enable cloud', { mode: 'lan', url: 'https://api.typesafe.ai', approved: ['https://api.typesafe.ai'], resolved: ['93.184.216.34'] }, false],
  ['approved Jev in hybrid mode', { mode: 'hybrid', url: 'https://api.typesafe.ai', approved: ['https://api.typesafe.ai'], resolved: ['93.184.216.34'] }, true],
  ['hybrid still blocks metadata', { mode: 'hybrid', url: 'http://169.254.169.254', approved: ['http://169.254.169.254'], resolved: ['169.254.169.254'] }, false],
  ['hybrid requires TLS for public hosts', { mode: 'hybrid', url: 'http://api.typesafe.ai', approved: ['http://api.typesafe.ai'], resolved: ['93.184.216.34'] }, false]
];
for (const [name, change, allowed] of cases) contract('egress', name, async driver => {
  const r = await driver.check({ ...local, ...change });
  assert.equal(r.allowed, allowed);
  assert.deepEqual(r.outbound, [], 'Network-policy tests use a controlled resolver and dialer');
});
