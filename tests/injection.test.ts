import test from 'node:test';
import assert from 'node:assert/strict';
import { contract } from './support/harness.ts';
import { attacks } from './support/attacks.ts';

test('injection corpus contains unique malicious vectors and benign controls', () => {
  assert.equal(new Set(attacks.map(a => a.id)).size, attacks.length);
  assert.ok(attacks.filter(a => a.malicious).length >= 12);
  assert.ok(attacks.filter(a => !a.malicious).length >= 3);
  for (const surface of ['customer', 'tool', 'policy-import', 'transcript', 'scenario-import'])
    assert.ok(attacks.some(a => a.surface === surface));
  for (const a of attacks) {
    assert.match(a.id, /^PI-\d{3}$/);
    assert.ok(a.payload.length > 5 && a.intent.length > 5);
  }
});
for (const provider of ['laya', 'jev'] as const)
  for (const mode of ['workbench', 'webapp'] as const)
    for (const detector of ['safe', 'suspicious', 'unavailable'] as const)
      for (const attack of attacks) contract('security', `${attack.id} ${provider}/${mode}/${detector}`, async driver => {
        const r = await driver.exercise({ attack, provider, detector, mode });
        assert.equal(r.hostMutations, 0, 'Evidence cannot mutate host settings, policy, secrets, or verdicts');
        assert.equal(r.arbitraryToolExecuted, false, 'No shell, arbitrary fetch, SQL, or filesystem capability');
        assert.deepEqual(r.secretsExposed, []);
        assert.deepEqual(r.outbound, [], 'Jev transport is mocked; no real cloud call');
        assert.equal(r.rawPayload, attack.payload, 'Preserve adversarial test evidence without sanitizing away the attack');
        assert.equal(r.trustedPolicyVersion, 'p1');
        assert.ok(r.guardCalls > 0, 'Test must exercise the configured guard integration');
        if (detector !== 'safe') assert.equal(r.reviewRequired, true);
        if (!attack.malicious && detector === 'safe') assert.equal(r.reviewRequired, false, 'Benign controls should not all be blocked');
      });
