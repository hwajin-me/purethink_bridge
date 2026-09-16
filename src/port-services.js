import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ORIGIN_HOST } from './origin.js';

export async function loadPortServices(filename, allowedPorts, otherPorts = []) {
  if (!filename) return {};
  const settings = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('PORT_SERVICES_FILE must contain a port-keyed object');
  const local = new Set(['0.0.0.0', ...Object.values(os.networkInterfaces()).flat().map((v) => v.address)]);
  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    const port = Number(key);
    if (String(port) !== key || !allowedPorts.includes(port)) throw new Error(`Port service ${key} is not an enabled service port`);
    if (!value || !['proxy', 'simulate'].includes(value.mode) || !['tcp', 'tls'].includes(value.transport)) throw new Error(`Invalid mode/transport for port ${port}`);
    const config = { ...value, port };
    if (value.mode === 'proxy') {
      const upstream = { host: ORIGIN_HOST, port, transport: 'tcp', ...value.upstream };
      if (upstream.host !== ORIGIN_HOST && net.isIP(upstream.host) !== 4) throw new Error(`Port ${port}: upstream host must be origin or IPv4`);
      if (!Number.isInteger(upstream.port) || upstream.port < 1 || upstream.port > 65535 || !['tcp', 'tls'].includes(upstream.transport)) throw new Error(`Port ${port}: invalid upstream`);
      if ((local.has(upstream.host) || upstream.host.startsWith('127.')) && [...allowedPorts, ...otherPorts].includes(upstream.port)) throw new Error(`Port ${port}: upstream loops into Bridge`);
      if (upstream.rejectUnauthorized !== undefined && typeof upstream.rejectUnauthorized !== 'boolean') throw new Error('rejectUnauthorized must be boolean');
      if (upstream.caFile) upstream.ca = fs.readFileSync(path.resolve(path.dirname(filename), upstream.caFile));
      config.upstream = upstream;
    } else {
      if (!['stream', 'http'].includes(value.protocol) || typeof value.module !== 'string') throw new Error(`Port ${port}: simulation requires protocol and module`);
      const module = await import(pathToFileURL(path.resolve(path.dirname(filename), value.module)).href);
      if (typeof module.createHandler !== 'function') throw new Error(`Port ${port}: module must export createHandler`);
      config.factory = module.createHandler;
    }
    result[port] = config;
  }
  return result;
}

export async function createPortService({ config, tlsOptions, lookup, context = {}, onError = () => {} }) {
  const { port, transport, mode } = config;
  const report = (error, socket) => onError(error, socket);
  let handler;
  if (mode === 'simulate') {
    handler = await config.factory({ ...context, port, config: config.options || {} });
    if (typeof handler !== 'function') throw new Error(`Port ${port}: createHandler must return a function`);
  } else {
    handler = (client) => {
      const target = config.upstream;
      const options = { host: target.host, port: target.port, family: 4, allowHalfOpen: true,
        ...(target.host === ORIGIN_HOST ? { lookup } : {}) };
      const encrypted = target.transport === 'tls';
      const upstream = encrypted ? tls.connect({ ...options, servername: target.servername || target.host,
        ca: target.ca, rejectUnauthorized: target.rejectUnauthorized !== false }) : net.connect(options);
      const timer = setTimeout(() => upstream.destroy(new Error('Upstream connection/handshake timeout')), 10000);
      upstream.once(encrypted ? 'secureConnect' : 'connect', () => clearTimeout(timer));
      upstream.once('close', () => { clearTimeout(timer); if (!upstream.readableEnded) client.destroy(); });
      upstream.on('error', (error) => { report(error, client); client.destroy(); });
      client.once('close', () => upstream.destroy());
      client.pipe(upstream).pipe(client);
    };
  }
  let server;
  if (mode === 'simulate' && config.protocol === 'http') {
    const request = (req, res) => {
      Promise.resolve().then(() => handler(req, res)).catch((error) => {
        report(error, req.socket);
        if (!res.headersSent) res.writeHead(500).end('Service handler failed'); else res.destroy();
      });
      req.on('error', () => {}); res.on('error', () => {});
    };
    server = transport === 'tls' ? https.createServer(tlsOptions, request) : http.createServer(request);
  } else {
    const connection = (socket) => {
      socket.on('error', (error) => report(error, socket));
      Promise.resolve().then(() => handler(socket)).catch((error) => { report(error, socket); socket.destroy(); });
    };
    server = transport === 'tls' ? tls.createServer({ ...tlsOptions, allowHalfOpen: true, handshakeTimeout: 10000 }, connection) : net.createServer({ allowHalfOpen: true }, connection);
  }
  server.on('tlsClientError', (error, socket) => report(error, socket));
  return server;
}
