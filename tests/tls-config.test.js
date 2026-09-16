import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { loadCustomTls, tlsListeners } from '../src/tls-config.js';
import { createOriginProxy } from '../src/origin-proxy.js';

test('custom Bridge defaults off and validates listener collisions', () => {
  assert.equal(tlsListeners({}, []).mode, 'passthrough');
  assert.equal(tlsListeners({ CUSTOM_BRIDGE_ENABLED: 'false' }, []).httpsPort, null);
  assert.equal(tlsListeners({ CUSTOM_BRIDGE_ENABLED: 'true' }, []).httpsPort, 443);
  assert.throws(() => tlsListeners({ CUSTOM_BRIDGE_ENABLED: 'yes' }, []));
  assert.throws(() => tlsListeners({ CUSTOM_BRIDGE_ENABLED: 'true', DASHBOARD_HTTPS_PORT: '443' }, []));
  assert.throws(() => loadCustomTls({ TLS_ROOT_CA_FILE: '/missing' }), /together/);
});

test('custom Root CA validates certificate and serves firmware over trusted HTTPS', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.crt', '-days', '2', '-subj', '/CN=Test Root', '-addext', 'basicConstraints=critical,CA:TRUE');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=dapt.iptime.org');
  fs.writeFileSync(path.join(dir, 'ext'), 'subjectAltName=DNS:dapt.iptime.org\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '2', '-extfile', 'ext');
  const env = { TLS_CERT_FILE: path.join(dir, 'leaf.crt'), TLS_KEY_FILE: path.join(dir, 'leaf.key'), TLS_ROOT_CA_FILE: path.join(dir, 'root.crt') };
  const config = loadCustomTls(env);
  assert.equal(config.info.rootCaAvailable, true);
  assert.throws(() => loadCustomTls({ ...env, TLS_KEY_FILE: path.join(dir, 'root.key') }));
  assert.throws(() => loadCustomTls({ ...env, TLS_ROOT_CA_FILE: path.join(dir, 'leaf.crt') }), /Root CA/);
  const server = createOriginProxy({ tlsOptions: config.options, firmware: { handle(req, res) {
    assert.equal(req.headers.range, 'bytes=0-3');
    res.writeHead(206, { 'Content-Range': 'bytes 0-3/4' }).end('test'); return true;
  } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (ca) => new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: server.address().port, servername: 'dapt.iptime.org', ca,
      headers: { Range: 'bytes=0-3' }, agent: false }, (res) => {
      let body = ''; res.on('data', (chunk) => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.deepEqual(await request(config.rootCa), { status: 206, body: 'test' });
  await assert.rejects(request(undefined));
  const freePort = async () => {
    const socket = net.createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    return String(port);
  };
  const ports = {};
  for (const name of ['HTTP_PORT', 'DEVICE_MQTT_PORT', 'ORIGIN_HTTP_PORT', 'CUSTOM_HTTP_PORT', 'HTTPS_PORT', 'DASHBOARD_HTTPS_PORT']) ports[name] = await freePort();
  const extraPort = await freePort();
  const servicesFile = path.join(dir, 'services.json');
  fs.writeFileSync(servicesFile, JSON.stringify({
    [extraPort]: { mode: 'simulate', transport: 'tls', protocol: 'http', module: path.resolve('src/services/http-json.js') },
    [ports.ORIGIN_HTTP_PORT]: { mode: 'simulate', transport: 'tcp', protocol: 'http', module: path.resolve('src/services/http-json.js') }
  }));
  const child = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, ...env, ...ports,
    DATA_DIR: path.join(dir, 'data'), FIRMWARE_DIR: path.join(dir, 'firmware'),
    CUSTOM_BRIDGE_ENABLED: 'true', ORIGIN_TCP_PORTS: extraPort, PORT_SERVICES_FILE: servicesFile, INTERNAL_MQTT_ENABLED: 'false',
    FIRMWARE_AUTO_PREPARE: 'false', LOCAL_OTA_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => output += b);
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); } });
  const get = (port, url, secure = true) => new Promise((resolve, reject) => {
    (secure ? https : http).get({ host: '127.0.0.1', port, path: url, servername: 'dapt.iptime.org', ca: config.rootCa, agent: false }, (res) => {
      let body = ''; res.on('data', (b) => body += b); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { status = await get(ports.DASHBOARD_HTTPS_PORT, '/api/status'); if (JSON.parse(status.body).state.bridge.origin.tcpPorts) break; } catch {}
    if (child.exitCode !== null) assert.fail(output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(JSON.parse(status.body).state.bridge.tls.mode, 'terminate');
  assert.equal((await get(ports.DASHBOARD_HTTPS_PORT, '/tls/root-ca.crt')).body, config.rootCa);
  assert.equal(JSON.parse((await get(extraPort, '/health')).body).port, Number(extraPort));
  assert.equal((await get(ports.ORIGIN_HTTP_PORT, '/firmware/ver.220706.1633_DIV01.bin', false)).status, 503);
  const currentStatus = JSON.parse((await get(ports.DASHBOARD_HTTPS_PORT, '/api/status')).body);
  assert.equal(currentStatus.state.bridge.access.ports[extraPort].accepted, 1);
  assert.equal(currentStatus.state.bridge.origin.tcpServices.find((service) => service.port === Number(extraPort)).mode, 'simulate-tls');
  for (const [port, secure] of [[ports.HTTPS_PORT, true], [ports.CUSTOM_HTTP_PORT, false]]) {
    assert.equal((await get(port, '/firmware/ver.220706.1633_DIV01.bin', secure)).status, 503);
  }
  await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: Number(ports.DEVICE_MQTT_PORT), servername: 'dapt.iptime.org', ca: config.rootCa }, () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
  });
});
