import net from 'node:net';
import os from 'node:os';
import { createTcpProxy } from './origin-proxy.js';
import { createPortService } from './port-services.js';
import { ORIGIN_HOST } from './origin.js';

export function validatePortRouting(settings, ports, reserved = []) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('portRouting must be an object');
  const local = new Set(['0.0.0.0', ...Object.values(os.networkInterfaces()).flat().map((entry) => entry.address)]);
  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    const port = Number(key);
    if (String(port) !== key || !ports.includes(port) || reserved.includes(port)) throw Error(`Port ${key} cannot be configured`);
    if (!value || !['bypass', 'proxy', 'custom'].includes(value.mode)) throw Error(`Port ${key}: invalid mode`);
    if (value.mode === 'bypass') { result[key] = { mode: 'bypass' }; continue; }
    if (!['tcp', 'tls'].includes(value.transport)) throw Error(`Port ${key}: invalid transport`);
    const next = { mode: value.mode, transport: value.transport };
    if (value.mode === 'proxy') {
      const target = value.upstream;
      if (!target || (target.host !== ORIGIN_HOST && net.isIP(target.host) !== 4) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !['tcp', 'tls'].includes(target.transport)) throw Error(`Port ${key}: invalid upstream (origin hostname or IPv4 required)`);
      if ((local.has(target.host) || target.host.startsWith('127.')) && [...ports, ...reserved].includes(target.port)) throw Error(`Port ${key}: upstream loops into Bridge`);
      next.upstream = { host: target.host, port: target.port, transport: target.transport };
    } else {
      if (!['http', 'stream'].includes(value.protocol)) throw Error(`Port ${key}: invalid custom protocol`);
      if (typeof value.response !== 'string' || Buffer.byteLength(value.response) > 16384) throw Error(`Port ${key}: response must be text up to 16 KiB`);
      next.protocol = value.protocol; next.response = value.response;
    }
    result[key] = next;
  }
  return result;
}

// A stable listening socket dispatches new connections to prepared protocol servers.
// Existing connections keep their original handler and logging mode until they close.
export function createPortRouter({ ports, reserved, tlsOptions, lookup, accessLog, discovery, legacy = {} }) {
  const active = new Map();
  const listeners = new Map();
  const services = ports.map((port) => ({ port, status: 'starting', mode: 'bypass', connections: 0, lastError: null }));
  async function prepare(settings) {
    const clean = validatePortRouting(settings, ports, reserved);
    const prepared = new Map();
    for (const service of services) {
      const port = service.port;
      const config = clean[port];
      const mode = config?.mode || legacy[port]?.mode || 'bypass';
      const report = (error, socket) => {
        service.lastError = error.message;
        accessLog.record({ event: mode === 'custom' ? 'service-error' : 'upstream-error', port, mode, remoteAddress: socket?.remoteAddress, remotePort: socket?.remotePort, error: error.message });
      };
      let server;
      if (!config && legacy[port]) server = legacy[port].server;
      else if (!config || mode === 'bypass') server = createTcpProxy({ port, lookup, onError: report });
      else server = await createPortService({ config: { ...config, port, mode: mode === 'custom' ? 'simulate' : 'proxy',
        factory: () => config.protocol === 'http' ? (req, res) => {
          req.resume();
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(config.response) });
          res.end(req.method === 'HEAD' ? undefined : config.response);
        } : (socket) => { socket.resume(); socket.end(config.response); }
      }, tlsOptions, lookup, onError: report,
        onConnection: (socket) => discovery?.observe(socket, { port, mode }) });
      prepared.set(port, { server, mode, config: config || (legacy[port] ? null : { mode: 'bypass' }) });
    }
    return { clean, commit() {
      for (const service of services) {
        const entry = prepared.get(service.port);
        active.set(service.port, entry);
        service.mode = entry.mode; service.lastError = null;
        service.target = entry.mode === 'bypass' ? { host: ORIGIN_HOST, port: service.port } : entry.config?.upstream || null;
        if (accessLog.state.ports[service.port]) accessLog.state.ports[service.port].mode = entry.mode;
      }
    } };
  }
  function listen(host) {
    return Promise.all(services.map((service) => new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: true });
      accessLog.observe(server, { port: service.port, mode: () => active.get(service.port).mode });
      server.on('connection', (socket) => {
        const entry = active.get(service.port);
        service.connections++; service.lastConnected = new Date().toISOString();
        socket.on('error', () => {});
        if (!entry.config || entry.mode === 'bypass' || entry.config.protocol === 'http') discovery?.observe(socket, { port: service.port, mode: entry.mode });
        entry.server.emit('connection', socket);
      });
      listeners.set(service.port, server);
      server.on('error', (error) => { service.lastError = error.message; service.status = 'error'; reject(error); });
      server.listen(service.port, host, () => { service.status = 'listening'; resolve(); });
    })));
  }
  return { services, prepare, listen, entries: () => services.map((service) => ({ ...service, config: active.get(service.port)?.config })),
    close: () => Promise.all([...listeners.values()].map((server) => new Promise((resolve) => server.close(resolve)))) };
}
