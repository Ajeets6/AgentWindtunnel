import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { approveEndpoint, endpointUrl } from './egress.ts';
import type { NetworkMode } from './egress.ts';

export type TransportRequest = { url: string; body?: unknown; method?: 'GET' | 'POST'; headers?: Record<string, string>; signal?: AbortSignal };
export type JsonTransport = (request: TransportRequest) => Promise<unknown>;
export class ControlledTransport {
  readonly requests: TransportRequest[] = [];
  private handler: (request: TransportRequest) => Promise<unknown>;
  constructor(handler: (request: TransportRequest) => Promise<unknown>) { this.handler = handler; }
  readonly send: JsonTransport = async request => {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    return this.handler(request);
  };
}

/** Resolve once, pin lookup, check the connected peer, then release request data. */
export function safeTransport(policy: { mode: NetworkMode; approved: string[]; timeoutMs?: number; maxBytes?: number }): JsonTransport {
  return async input => {
    const url = endpointUrl(input.url);
    if (!policy.approved.some(value => endpointUrl(value).origin === url.origin)) throw new Error('Endpoint not approved');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const deadline = AbortSignal.any([AbortSignal.timeout(policy.timeoutMs ?? 30000), ...(input.signal ? [input.signal] : [])]);
    const addresses = isIP(hostname) ? [hostname] : (await Promise.race([
      lookup(hostname, { all: true, verbatim: true }).then(rows => rows.map(row => row.address)),
      new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Error('DNS deadline exceeded')), { once: true })),
    ]));
    const approval = { url: input.url, mode: policy.mode, approved: policy.approved, resolved: addresses };
    if (!approveEndpoint(approval)) throw new Error('Endpoint denied by network policy');
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    if (body && body.length > 1024 * 1024) throw new Error('Provider request too large');
    return new Promise((resolve, reject) => {
      const tls = url.protocol === 'https:';
      const request = (tls ? https : http).request(url, {
        method: input.method ?? 'POST', agent: false, signal: deadline, family: isIP(addresses[0]),
        headers: { 'Accept-Encoding': 'identity', ...input.headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) },
        lookup: (_host, _options, callback) => callback(null, addresses[0], isIP(addresses[0])),
      }, response => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          response.destroy(); reject(new Error(`Provider HTTP ${response.statusCode}`)); return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(new Error('Compressed provider response denied')); return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > (policy.maxBytes ?? 1024 * 1024)) { response.destroy(new Error('Provider response too large')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('Invalid provider JSON')); }
        });
      });
      request.on('error', reject);
      request.on('socket', socket => {
        socket.once(tls ? 'secureConnect' : 'connect', () => {
          if (!socket.remoteAddress || !approveEndpoint({ ...approval, connectedAddress: socket.remoteAddress })) {
            request.destroy(new Error('Connected peer differs from approved DNS')); return;
          }
          request.end(body);
        });
      });
    });
  };
}
