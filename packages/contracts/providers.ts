import { z } from 'zod';
import { endpointUrl, addressClass } from '../providers/egress.ts';

export const providerSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  name: z.string().min(1).max(100),
  protocol: z.enum(['ollama', 'systemone', 'chat-completions', 'openai-responses']),
  engine: z.enum(['laya', 'jev']).optional(),
  baseUrl: z.string().max(500), model: z.string().min(1).max(200),
  modelRevision: z.string().min(1).max(200), tokenizerRevision: z.string().min(1).max(200).default('unverified'),
  roles: z.array(z.enum(['agent', 'judge', 'injection-guard'])).min(1).max(3),
  networkMode: z.enum(['local', 'lan', 'hybrid']).default('local'), cloudConsent: z.boolean().default(false),
  secretRef: z.string().regex(/^AW_[A-Z0-9_]+$/).optional(),
  contextLimit: z.number().int().min(128).max(131072).default(1024),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  prices: z.strictObject({ input: z.number().int().positive().max(1000000000), output: z.number().int().positive().max(1000000000) }).optional(),
  enabled: z.boolean().default(true),
}).superRefine((value, ctx) => {
  try {
    const url = endpointUrl(value.baseUrl);
    if (url.pathname !== '/' || url.search) throw new Error('Provider URL must be an origin');
    if (/cloud/i.test(value.model)) throw new Error('Cloud aliases are not local models');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const locality = addressClass(host);
    if (value.networkMode === 'local' && locality !== 'loopback' && host !== 'localhost') throw new Error('Local provider must use loopback');
    if (value.networkMode === 'hybrid' && (!value.cloudConsent || !value.prices || url.protocol !== 'https:'))
      throw new Error('Hybrid requires explicit consent, TLS and configured prices');
    if (value.engine === 'jev' && value.networkMode !== 'hybrid') throw new Error('Jev is hosted and opt-in');
    if (value.protocol === 'systemone' && !value.engine) throw new Error('System One engine required');
    if (value.roles.includes('agent') && value.protocol === 'systemone') throw new Error('System One cannot generate agent actions');
    if (value.protocol === 'ollama' && value.networkMode === 'hybrid') throw new Error('Ollama adapter requires a local or LAN model');
  } catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid provider' }); }
});
export type ProviderConfig = z.infer<typeof providerSchema>;
export type Review = { id: string; executionId: string; checkId: 'message_truth' | 'injection';
  status: 'pass' | 'fail' | 'needs_review'; note: string; createdAt: string; reviewer: string };
