import net from 'node:net';
import os from 'node:os';

export function customTcpRoutes(value = '{}', listenerPorts = [], otherPorts = []) {
  const routes = JSON.parse(value);
  if (!routes || Array.isArray(routes) || typeof routes !== 'object') throw new Error('CUSTOM_TCP_ROUTES must be a JSON object');
  const localAddresses = new Set(['0.0.0.0', '127.0.0.1', ...Object.values(os.networkInterfaces()).flat().map((v) => v.address)]);
  for (const [source, target] of Object.entries(routes)) {
    if (!listenerPorts.includes(Number(source)) || String(Number(source)) !== source) throw new Error(`Custom route is not an enabled TCP listener: ${source}`);
    if (!target || net.isIP(target.host) !== 4 || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error(`Custom route ${source} requires an IPv4 host and integer port`);
    if ((localAddresses.has(target.host) || target.host.startsWith('127.')) && [...listenerPorts, ...otherPorts].includes(target.port)) throw new Error(`Custom route ${source} loops into a Bridge listener`);
  }
  return routes;
}
