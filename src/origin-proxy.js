import http from 'node:http';
import net from 'node:net';
import { ORIGIN_HOST } from './origin.js';
import { isVersionRoute } from './firmware.js';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];
function endToEndHeaders(headers) {
  const result = { ...headers };
  const named = String(headers.connection || '').split(',').map((name) => name.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...named]) delete result[name];
  return result;
}

export function createOriginProxy({ lookup, originPort = 6002,
  localOta = false, firmware, onError = () => {} }) {
  return http.createServer((req, res) => {
    // Destination is fixed; client Host/absolute URLs cannot turn this into an open proxy.
    if (!req.url.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end('Origin-form request target required');
      return;
    }
    if (firmware?.handle(req, res, localOta)) return;
    if (!firmware && localOta && isVersionRoute(req.url)) {
      res.writeHead(503).end('Verified firmware store is unavailable');
      return;
    }
    const upstream = http.request({
      hostname: ORIGIN_HOST,
      port: originPort,
      lookup, family: 4, method: req.method, path: req.url,
      headers: { ...endToEndHeaders(req.headers), host: `${ORIGIN_HOST}:${originPort}` },
      // No pooled socket may outlive the DNS TTL.
      agent: false
    }, (response) => {
      clearTimeout(deadline);
      res.writeHead(response.statusCode, endToEndHeaders(response.headers));
      response.on('error', (error) => res.destroy(error));
      response.pipe(res);
    });
    const deadline = setTimeout(() => upstream.destroy(new Error('Origin HTTP connect/headers timeout')), 10000);
    upstream.once('close', () => clearTimeout(deadline));
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Origin HTTP timeout')));
    upstream.on('error', (error) => {
      onError(error);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Origin unavailable\n');
      else res.destroy(error);
    });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
}

// Optional additional origin services, including HTTPS without replacing its certificate.
export function createTcpProxy({ port, lookup, onError = () => {} }) {
  return net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({ host: ORIGIN_HOST, port, lookup, family: 4, allowHalfOpen: true });
    const timeout = setTimeout(() => upstream.destroy(new Error('Origin TCP connect timeout')), 10000);
    upstream.once('connect', () => clearTimeout(timeout));
    upstream.once('close', () => {
      clearTimeout(timeout);
      // Let pipe drain a complete response before closing the downstream socket.
      if (!upstream.readableEnded) client.destroy();
    });
    client.once('close', () => upstream.destroy());
    upstream.on('error', (error) => { onError(error); client.destroy(); });
    client.on('error', () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  });
}
