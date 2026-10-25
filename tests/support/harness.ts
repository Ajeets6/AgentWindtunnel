import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Harness } from './contracts.ts';

export function missingMode(strict: boolean) { return strict ? 'fail' : 'todo'; }
export async function loadFactory(path: string) {
  if (!existsSync(path)) return undefined;
  const module = await import(pathToFileURL(path).href);
  assert.equal(typeof module.createHarness, 'function', 'Adapter must export createHarness');
  return module.createHarness as () => Promise<Harness>;
}
const adapterPath = resolve(process.env.AW_TEST_ADAPTER ?? 'tests/adapters/application.ts');
const factory = await loadFactory(adapterPath);
if (process.env.AW_TEST_ADAPTER && !factory) throw new Error(`Configured adapter does not exist: ${adapterPath}`);

/** A fresh temporary DB/transport per test; adapter owns teardown. Missing features are visible TODOs. */
export function contract<K extends Exclude<keyof Harness, 'dispose'>>(
  capability: K, name: string, body: (driver: NonNullable<Harness[K]>) => Promise<void>
) {
  const strict = process.env.AW_STRICT_TESTS === '1';
  if (!factory) {
    const title = `[${capability}] ${name} — application adapter not implemented`;
    if (missingMode(strict) === 'todo') test.todo(title);
    else test(title, () => assert.fail(`Missing ${adapterPath}`));
    return;
  }
  test(`[${capability}] ${name}`, { timeout: 15000 }, async t => {
    const harness = await factory();
    assert.equal(typeof harness.dispose, 'function');
    t.after(() => harness.dispose());
    const driver = harness[capability];
    if (!driver) {
      if (strict) assert.fail(`Missing capability: ${capability}`);
      t.todo(`Application capability not implemented: ${capability}`);
      return;
    }
    await body(driver as NonNullable<Harness[K]>);
  });
}
