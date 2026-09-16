import { Resolver } from 'node:dns/promises';
import os from 'node:os';

export const ORIGIN_HOST = 'dapt.iptime.org';
export const DNS_SERVERS = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4'];

export function isLocalAddress(address) {
  const [first, second] = address.split('.').map(Number);
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127) ||
    Object.values(os.networkInterfaces()).flat().some((entry) => entry?.address === address);
}

// A resolver per provider also falls back on NXDOMAIN, not just timeouts.
// Never use OS DNS: the LAN deliberately resolves this name to the bridge.
export function createOriginLookup({ resolverFactory = () => new Resolver({ timeout: 1500, tries: 1 }),
  now = Date.now, isBlocked = isLocalAddress, onUpdate = () => {} } = {}) {
  let cache;
  let pending;
  let cursor = 0;
  async function resolve() {
    if (cache && now() < cache.expires) return cache.records;
    if (pending) return pending;
    pending = (async () => {
      const failures = [];
      for (const server of DNS_SERVERS) {
        try {
          const resolver = resolverFactory();
          resolver.setServers([server]);
          const records = await resolver.resolve4(ORIGIN_HOST, { ttl: true });
          if (!records.length || records.some(({ address }) => isBlocked(address))) {
            throw new Error('Empty or self-referencing origin DNS answer');
          }
          const ttl = Math.min(300, ...records.map((record) => Math.max(0, record.ttl)));
          cache = { records, expires: now() + ttl * 1000 };
          onUpdate({ addresses: records.map(({ address }) => address), server, expiresAt: cache.expires, lastError: null });
          return records;
        } catch (error) {
          failures.push(`${server}: ${error.message}`);
        }
      }
      const error = new Error(`Origin DNS failed: ${failures.join('; ')}`);
      error.code = 'EAI_AGAIN';
      onUpdate({ addresses: [], server: null, expiresAt: null, lastError: error.message });
      throw error;
    })();
    try { return await pending; } finally { pending = null; }
  }
  function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (hostname !== ORIGIN_HOST) {
      callback(new Error(`Unexpected origin hostname: ${hostname}`));
      return;
    }
    resolve().then((records) => {
      const ordered = records.map((_, index) => ({ address: records[(index + cursor) % records.length].address, family: 4 }));
      cursor = (cursor + 1) % records.length;
      if (options?.all) callback(null, ordered);
      else callback(null, ordered[0].address, 4);
    }, callback);
  }
  return { lookup, resolve };
}
