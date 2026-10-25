import { isIP, BlockList } from 'node:net';

export type NetworkMode = 'local' | 'lan' | 'hybrid';
export type EndpointCheck = {
  url: string; mode: NetworkMode; approved: string[]; resolved: string[];
  connectedAddress?: string; redirect?: string; model?: string;
};
const reserved = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) reserved.addSubnet(address, prefix, 'ipv4');
const private4 = new BlockList();
private4.addSubnet('10.0.0.0', 8, 'ipv4'); private4.addSubnet('172.16.0.0', 12, 'ipv4'); private4.addSubnet('192.168.0.0', 16, 'ipv4');
const public6 = new BlockList(); public6.addSubnet('2000::', 3, 'ipv6');
const reserved6 = new BlockList();
reserved6.addSubnet('2001::', 23, 'ipv6'); reserved6.addSubnet('2001:db8::', 32, 'ipv6'); reserved6.addSubnet('2002::', 16, 'ipv6');
const private6 = new BlockList(); private6.addSubnet('fc00::', 7, 'ipv6');

export function addressClass(address: string): 'loopback' | 'lan' | 'public' | 'blocked' {
  if (isIP(address) === 4) {
    if (address.startsWith('127.')) return 'loopback';
    if (private4.check(address, 'ipv4')) return 'lan';
    return reserved.check(address, 'ipv4') ? 'blocked' : 'public';
  }
  if (isIP(address) === 6) {
    const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
    if (canonical === '::1') return 'loopback';
    if (private6.check(address, 'ipv6')) return 'lan';
    return public6.check(address, 'ipv6') && !reserved6.check(address, 'ipv6') ? 'public' : 'blocked';
  }
  return 'blocked';
}

export function endpointUrl(value: string): URL {
  if (value !== value.trim() || /[\\\s]/.test(value)) throw new Error('Invalid endpoint');
  const raw = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?(?:[/?#]|$)/.exec(value);
  if (!raw || /[@%]/.test(raw[1])) throw new Error('Invalid endpoint authority');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.hostname.endsWith('.'))
    throw new Error('Invalid endpoint');
  if (isIP(url.hostname) === 4 && raw[1] !== url.hostname) throw new Error('Noncanonical numeric IP');
  return url;
}

export function approveEndpoint(input: EndpointCheck): boolean {
  try {
    if (input.redirect || (input.model && /(?:^|[:/._-])cloud(?:$|[:/._-])/i.test(input.model))) return false;
    const url = endpointUrl(input.url);
    if (!input.approved.some(value => endpointUrl(value).origin === url.origin)) return false;
    if (!input.resolved.length) return false;
    const classes = input.resolved.map(addressClass);
    if (classes.includes('blocked') || new Set(classes).size !== 1) return false;
    const locality = classes[0];
    if (locality === 'public' && (input.mode !== 'hybrid' || url.protocol !== 'https:')) return false;
    if (locality === 'lan' && input.mode === 'local') return false;
    if (input.connectedAddress && (!input.resolved.includes(input.connectedAddress) || addressClass(input.connectedAddress) !== locality)) return false;
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !input.resolved.every(a => {
      if (a === literal) return true;
      return isIP(a) === 6 && isIP(literal) === 6 && new URL(`http://[${a}]`).hostname === url.hostname;
    })) return false;
    return true;
  } catch { return false; }
}
