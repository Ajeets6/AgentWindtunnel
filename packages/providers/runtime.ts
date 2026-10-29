import { z } from 'zod';
import { safeTransport } from './transport.ts';
import type { JsonTransport } from './transport.ts';
import type { ProviderConfig } from '../contracts/providers.ts';
import { SystemOneClient, cacheKey } from './systemone.ts';
import { SuiteStore } from '../../apps/server/store.ts';
import { redact } from '../../apps/server/security.ts';

export function providerTransport(provider: ProviderConfig, store: SuiteStore, scope: { suiteId: string; budgetMicros: number; ownerId?: string; role?: 'agent' | 'judge' | 'injection-guard' }, secrets: string[], transport?: JsonTransport): JsonTransport {
  const send = transport ?? safeTransport({ mode: provider.networkMode, approved: [provider.baseUrl], timeoutMs: provider.timeoutMs });
  return async request => {
    if (scope.ownerId) {
      const current = store.documents<ProviderConfig>(scope.ownerId, 'provider').find(value => value.id === provider.id);
      if (!current?.enabled || (scope.role && !current.roles.includes(scope.role)) ||
        (provider.networkMode === 'hybrid' && (!current.cloudConsent || current.networkMode !== 'hybrid')) ||
        current.baseUrl !== provider.baseUrl || current.secretRef !== provider.secretRef || current.model !== provider.model ||
        current.networkMode !== provider.networkMode || JSON.stringify(current.prices) !== JSON.stringify(provider.prices))
        throw new Error('Provider permission revoked or configuration changed');
    }
    const key = provider.secretRef ? process.env[provider.secretRef] : undefined;
    if (provider.secretRef && !key) throw new Error('Provider secret reference is unset');
    const hosted = provider.networkMode === 'hybrid';
    let reservation: string | undefined;
    if (hosted) {
      if (!provider.cloudConsent || !provider.prices) throw new Error('Hosted permission or pricing unavailable');
      const inputBound = Math.max(provider.contextLimit, 2 * Buffer.byteLength(JSON.stringify(request.body ?? {})) + 256);
      const outputBound = Number((request.body as Record<string, unknown> | undefined)?.max_output_tokens ?? (request.body as Record<string, unknown> | undefined)?.max_tokens ?? 512);
      if (!Number.isSafeInteger(outputBound) || outputBound < 1 || outputBound > 4096) throw new Error('Invalid output budget');
      const maximum = Math.ceil((inputBound * provider.prices.input + outputBound * provider.prices.output) / 1000000);
      reservation = store.reserve(scope.suiteId, scope.budgetMicros, Math.max(1, maximum));
    }
    // Redact before any hosted egress. Auth is attached only after redaction.
    const safe = hosted ? redact({ ...request, signal: undefined }, [...secrets, ...(key ? [key] : [])]) : request;
    const response = await send({ ...safe, signal: request.signal, headers: { ...safe.headers, ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
    if (reservation && provider.prices) {
      const rawUsage = (response as { usage?: Record<string, unknown> }).usage;
      const usage = z.object({ input_tokens: z.number().int().nonnegative().safe(), output_tokens: z.number().int().nonnegative().safe() })
        .parse(provider.protocol === 'chat-completions' ? { input_tokens: rawUsage?.prompt_tokens, output_tokens: rawUsage?.completion_tokens } : rawUsage);
      store.settle(reservation, Math.ceil((usage.input_tokens * provider.prices.input + usage.output_tokens * provider.prices.output) / 1000000));
    }
    return redact(response, [...secrets, ...(key ? [key] : [])]);
  };
}

export function decisionClient(provider: ProviderConfig, store: SuiteStore, ownerId: string,
  scope: { suiteId: string; executionId: string; budgetMicros: number; role?: 'judge' | 'injection-guard' }, secrets: string[]) {
  const send = providerTransport(provider, store, { ...scope, ownerId, role: scope.role ?? 'judge' }, secrets);
  const cacheSend: JsonTransport = async request => {
    const id = cacheKey({ ownerId, ...scope, provider, request: { url: request.url, body: request.body }, rubricVersion: 'message-v1', guardVersion: 'guard-v1', policyVersion: 'p1' });
    const cached = store.documents<{ id: string; value: unknown }>(ownerId, 'decision-cache').find(item => item.id === id);
    if (cached) return cached.value;
    const value = await send(request);
    // Cache raw evidence-bound responses. Validation still runs on every hit.
    store.put(ownerId, 'decision-cache', id, { id, value: redact(value, secrets) });
    return value;
  };
  return new SystemOneClient({ provider: provider.engine ?? 'laya', baseUrl: provider.baseUrl,
    model: provider.model, modelRevision: provider.modelRevision, tokenizerRevision: provider.tokenizerRevision,
    networkMode: provider.networkMode, cloudAllowed: provider.cloudConsent, calibrated: false,
    contextLimit: provider.contextLimit, workspaceId: ownerId, executionId: scope.executionId,
    rubricVersion: 'message-v1', policyVersion: 'p1', guardVersion: 'guard-v1' }, cacheSend, async body => {
    if (provider.engine === 'jev') throw new Error('Exact hosted preflight not configured');
    const preflight = await send({ url: provider.baseUrl + '/v1/preflight', body });
    const parsed = z.object({ exact: z.literal(true), input_tokens: z.number().int().nonnegative(),
      model_revision: z.literal(provider.modelRevision), tokenizer_revision: z.literal(provider.tokenizerRevision) }).parse(preflight);
    return parsed.input_tokens;
  });
}
