import { safeTransport } from '../packages/providers/transport.ts';
import { SystemOneClient } from '../packages/providers/systemone.ts';
import { z } from 'zod';

const baseUrl = 'http://127.0.0.1:8000';
const send = safeTransport({ mode: 'local', approved: [baseUrl], timeoutMs: 30000 });
const health = z.object({ ready: z.literal(true), model_revision: z.string(), tokenizer_revision: z.string().optional() })
  .parse(await send({ url: baseUrl + '/health', method: 'GET' }));
const client = new SystemOneClient({ provider: 'laya', baseUrl, model: 'laya-typed-decisions', modelRevision: health.model_revision,
  tokenizerRevision: health.tokenizer_revision ?? health.model_revision, networkMode: 'local', cloudAllowed: false,
  calibrated: false, contextLimit: 1024, workspaceId: 'local-smoke', executionId: 'smoke', rubricVersion: 'message-v1', policyVersion: 'p1', guardVersion: 'guard-v1' },
  send, async body => z.object({ exact: z.literal(true), input_tokens: z.number().int() }).parse(await send({ url: baseUrl + '/v1/preflight', body })).input_tokens);
const result = await client.evaluate({ evidence: JSON.stringify({ agentMessage: 'Your refund has been processed.', verified: { refundCount: 0 } }), complete: true });
if (result.status !== 'needs_review' || !result.request || result.generatedTokens !== 0) throw new Error('Laya smoke failed or bypassed review');
const overflow = await client.evaluate({ evidence: 'long evidence '.repeat(6000), complete: true });
if (overflow.status === 'accepted' || overflow.request) throw new Error('Overflow reached inference');
console.log(JSON.stringify({ health, status: result.status, label: result.label, reason: result.reason,
  probabilities: result.probabilities, generatedTokens: result.generatedTokens, overflow: overflow.status,
  note: 'One technical smoke, not an accuracy benchmark; no automatic acceptance.' }, null, 2));
