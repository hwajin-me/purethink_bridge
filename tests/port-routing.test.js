import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { validatePortRouting } from '../src/port-routing.js';

async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(40); } throw Error('Timed out'); }
function exchange(port, payload, encrypted = false) {
  return new Promise((resolve, reject) => {
    const client = encrypted ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
    const chunks = [];
    client.on('data', (chunk) => chunks.push(chunk));
    client.on('error', reject);
    client.on('close', () => resolve(Buffer.concat(chunks).toString()));
    client.once(encrypted ? 'secureConnect' : 'connect', () => client.end(payload));
  });
}
test('routing validation rejects fixed ports, loops, arbitrary modules and invalid responses', () => {
  for (const settings of [null, [], { 6002: { mode: 'bypass' } }, { 8080: { mode: 'simulate' } },
    { 8080: { mode: 'proxy', transport: 'tcp', upstream: { host: '127.0.0.1', port: 8885, transport: 'tcp' } } },
    { 8080: { mode: 'custom', transport: 'tcp', protocol: 'http', response: 'x'.repeat(16385) } }]) {
    assert.throws(() => validatePortRouting(settings, [8080], [6002, 8885]));
  }
  assert.deepEqual(validatePortRouting({ 8080: { mode: 'bypass', module: '/tmp/never-load.js' } }, [8080]), { 8080: { mode: 'bypass' } });
});

test('web API switches live bypass/proxy/custom with logs, validation and restart persistence', { timeout: 20000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-routing-'));
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  const echoPort = echo.address().port;
  const [dashboard, mqttPort, httpPort, routePort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const preload = path.join(dir, 'network.mjs');
  await fs.writeFile(preload, `
    import net from 'node:net';
    import { Resolver } from 'node:dns/promises';
    Resolver.prototype.resolve4 = async () => [{address:'203.0.113.4',ttl:60}];
    const connect = net.connect;
    net.connect = function(options, ...rest) {
      if (options.host === 'dapt.iptime.org' && options.port === ${routePort}) {
        const lookup = options.lookup;
        return connect({...options, port:${echoPort}, lookup(host, opts, cb) {
          lookup(host, opts, (err) => cb(err, '127.0.0.1', 4));
        }}, ...rest);
      }
      return connect(options, ...rest);
    };
  `);
  const env = { ...process.env, DATA_DIR: dir, HTTP_PORT: String(dashboard), DEVICE_MQTT_PORT: String(mqttPort), ORIGIN_HTTP_PORT: String(httpPort),
    ORIGIN_TCP_PORTS: String(routePort), FIRMWARE_AUTO_PREPARE: 'false', CUSTOM_BRIDGE_ENABLED: 'false', INTERNAL_MQTT_ENABLED: 'false' };
  let output = '';
  function start() { const child = spawn(process.execPath, ['--import', preload, 'src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (v) => output += v); child.stderr.on('data', (v) => output += v); return child; }
  let child = start();
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await new Promise((resolve) => echo.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${dashboard}`;
  const ready = () => until(async () => { if (child.exitCode !== null) throw Error(output); try { return (await fetch(`${base}/api/ports`)).ok; } catch { return false; } });
  await ready();
  const initial = await (await fetch(`${base}/api/ports`)).json();
  assert.equal(initial.ports[0].mode, 'bypass');
  assert.deepEqual(initial.fixed.map((entry) => entry.port), [httpPort, mqttPort]);
  assert.equal(await exchange(routePort, 'bypass bytes'), 'bypass bytes');
  const update = (value, port = routePort) => fetch(`${base}/api/ports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portRouting: { [port]: value } }) });
  assert.equal((await update({ mode: 'proxy', transport: 'tcp', upstream: { host: '127.0.0.1', port: echoPort, transport: 'tcp' } })).status, 200);
  assert.equal(await exchange(routePort, 'proxy bytes'), 'proxy bytes');
  // Connections already open retain their proxy handler across a mode change.
  const existing = net.connect(routePort, '127.0.0.1'); await once(existing, 'connect');
  const first = once(existing, 'data'); existing.write('before'); assert.equal((await first)[0].toString(), 'before');
  assert.equal((await update({ mode: 'custom', transport: 'tcp', protocol: 'http', response: 'custom response 한글' })).status, 200);
  const second = once(existing, 'data'); existing.write('after'); assert.equal((await second)[0].toString(), 'after'); existing.end(); await once(existing, 'close');
  assert.equal(await (await fetch(`http://127.0.0.1:${routePort}/anything`, { headers: { connection: 'close' } })).text(), 'custom response 한글');
  const saved = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
  assert.equal((await update({ mode: 'bypass' }, httpPort)).status, 400);
  assert.equal((await update({ mode: 'proxy', transport: 'tcp', upstream: { host: '127.0.0.1', port: dashboard, transport: 'tcp' } })).status, 400);
  assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), saved);
  // A failed disk write must not switch the active service.
  const configFile = path.join(dir, 'config.json');
  await fs.rename(configFile, `${configFile}.backup`); await fs.mkdir(configFile);
  try {
    assert.equal((await update({ mode: 'bypass' })).status, 400);
    assert.equal(await (await fetch(`http://127.0.0.1:${routePort}/unchanged`, { headers: { connection: 'close' } })).text(), 'custom response 한글');
  } finally { await fs.rmdir(configFile); await fs.rename(`${configFile}.backup`, configFile); }
  child.kill(); await once(child, 'exit'); child = start(); await ready();
  assert.equal(await (await fetch(`http://127.0.0.1:${routePort}/restored`, { headers: { connection: 'close' } })).text(), 'custom response 한글');
  assert.equal((await update({ mode: 'custom', transport: 'tls', protocol: 'http', response: 'secure HTTP' })).status, 200);
  const body = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: routePort, rejectUnauthorized: false, agent: false }, (res) => { let value = ''; res.on('data', (chunk) => value += chunk); res.on('end', () => resolve(value)); }).on('error', reject));
  assert.equal(body, 'secure HTTP');
  assert.equal((await update({ mode: 'custom', transport: 'tls', protocol: 'stream', response: 'secure stream' })).status, 200);
  assert.equal(await exchange(routePort, '', true), 'secure stream');
  assert.equal((await update({ mode: 'proxy', transport: 'tls', upstream: { host: '127.0.0.1', port: echoPort, transport: 'tcp' } })).status, 200);
  assert.equal(await exchange(routePort, 'TLS proxy', true), 'TLS proxy');
  const unavailable = await freePort();
  assert.equal((await update({ mode: 'proxy', transport: 'tcp', upstream: { host: '127.0.0.1', port: unavailable, transport: 'tcp' } })).status, 200);
  assert.equal(await exchange(routePort, 'unavailable'), '');
  assert.equal((await update({ mode: 'bypass' })).status, 200);
  assert.equal(await exchange(routePort, 'back to bypass'), 'back to bypass');
  await until(async () => (await fs.readFile(path.join(dir, 'logs/access.jsonl'), 'utf8')).includes('"bytesRead":14'));
  const logs = (await fs.readFile(path.join(dir, 'logs/access.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const mode of ['bypass', 'proxy', 'custom']) assert.ok(logs.some((entry) => entry.port === routePort && entry.event === 'close' && entry.mode === mode && entry.bytesWritten > 0));
  assert.ok(logs.some((entry) => entry.event === 'routing-updated'));
  assert.ok(logs.some((entry) => entry.event === 'upstream-error' && entry.mode === 'proxy' && entry.error.includes('ECONNREFUSED')));
});
