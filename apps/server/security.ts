import { randomBytes, timingSafeEqual } from 'node:crypto';

export const token = () => randomBytes(32).toString('hex');
export function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class Sessions {
  private sessions = new Map<string, { token: string; ownerId: string; csrf: string; expires: number }>();
  create(ownerId: string) {
    const session = { token: token(), csrf: token(), ownerId, expires: Date.now() + 12 * 3600000 };
    this.sessions.set(session.token, session);
    return session;
  }
  get(value: string) {
    const session = this.sessions.get(value);
    if (!session || session.expires < Date.now()) { this.sessions.delete(value); return undefined; }
    return session;
  }
  delete(value: string) { this.sessions.delete(value); }
}

export function parseJson(text: string): unknown {
  // Count structural nesting before parsing; brackets inside strings are inert.
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') { if (++depth > 32) throw new Error('JSON depth limit'); }
    else if (char === ']' || char === '}') depth--;
  }
  const value: unknown = JSON.parse(text);
  function inspect(item: unknown): void {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Invalid number');
    if (typeof item === 'string' && item.length > 262144) throw new Error('String limit');
    if (Array.isArray(item) && item.length > 10000) throw new Error('Array limit');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Forbidden key');
      inspect(child);
    }
  }
  inspect(value);
  return value;
}

/** Redact before persistence and again at every response/stream boundary. */
export function redact<T>(value: T, secrets: string[]): T {
  const clean = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let text = item.replace(/Authorization\s*:\s*Bearer\s+\S+/gi, '[REDACTED]');
      for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
      return text;
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) =>
      [key, /^(authorization|api[-_]?key|secret|verificationCode|password)$/i.test(key) ? '[REDACTED]' : clean(child)]));
    return item;
  };
  return clean(value) as T;
}
