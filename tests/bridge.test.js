import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Aedes from 'aedes';
import mqtt from 'mqtt';
import selfsigned from 'selfsigned';

async function port() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise((r) => server.close(r)); return value; }
async function until(fn) { for (let i = 0; i < 160; i++) { const result = await fn(); if (result) return result; await delay(50); } throw new Error('Condition timed out'); }
const publish = (client, topic, body) => new Promise((resolve, reject) => client.publish(topic, body, { qos: 1 }, (error) => error ? reject(error) : resolve()));
const subscribe = (client, topic) => new Promise((resolve, reject) => client.subscribe(topic, (error) => error ? reject(error) : resolve()));

test('real bridge: auto local MQTT, three-way traffic, multi-device reconnect, config migration', { timeout: 25000 }, async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'purethink-test-'));
  const local = new Aedes(); const manufacturer = new Aedes();
  const localServer = net.createServer(local.handle);
  const pem = selfsigned.generate([{ name: 'commonName', value: 'dapt.iptime.org' }], { keySize: 2048 });
  const manufacturerServer = tls.createServer({ key: pem.private, cert: pem.cert }, manufacturer.handle);
  localServer.listen(0, '127.0.0.1'); manufacturerServer.listen(0, '127.0.0.1');
  await Promise.all([once(localServer, 'listening'), once(manufacturerServer, 'listening')]);
  const httpPort = await port(); const devicePort = await port(); const proxyPort = await port();
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({
    internalMqtt: { enabled: false, host: '', port: localServer.address().port },
    routerDnat: { password: 'obsolete-router-secret' }
  }));
  // All network traffic is confined to fixture brokers. Exercise the real origin lookup
  // before mapping its TEST-NET address to the fixture's loopback socket.
  const preload = path.join(data, 'fixture.mjs');
  await fs.writeFile(preload, `
    import { Resolver } from 'node:dns/promises';
    import tls from 'node:tls';
    Resolver.prototype.resolve4 = async () => [{ address: '203.0.113.44', ttl: 0 }];
    const connect = tls.connect;
    tls.connect = function(options, ...args) {
      if (options.host !== 'dapt.iptime.org') return connect(options, ...args);
      if (options.servername !== 'dapt.iptime.org') throw Error('SNI missing');
      const originLookup = options.lookup;
      return connect({ ...options, port: ${manufacturerServer.address().port}, lookup(host, opts, cb) {
        originLookup(host, opts, (err, address) => {
          if (err) return cb(err);
          if (address !== '203.0.113.44') throw Error('Origin DNS bypassed');
          cb(null, '127.0.0.1', 4);
        });
      } }, ...args);
    };
  `);
  const spawnBridge = () => spawn(process.execPath, ['--import', preload, 'src/index.js'], { env: { ...process.env,
    DATA_DIR: data, HTTP_PORT: String(httpPort), DEVICE_MQTT_PORT: String(devicePort),
    ORIGIN_HTTP_PORT: String(proxyPort), INTERNAL_MQTT_HOST: '127.0.0.1', ORIGIN_TCP_PORTS: '', LOCAL_OTA_ENABLED: 'false', FIRMWARE_AUTO_PREPARE: 'false', CUSTOM_BRIDGE_ENABLED: 'false', PORT_SERVICES_FILE: '/nonexistent/must-not-load.json' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let child = spawnBridge();
  let output = '';
  const watch = (process) => { process.stdout.on('data', (chunk) => { output += chunk; }); process.stderr.on('data', (chunk) => { output += chunk; }); };
  watch(child);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.end(true);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await Promise.all([new Promise((r) => local.close(r)), new Promise((r) => manufacturer.close(r))]);
    localServer.close(); manufacturerServer.close(); await fs.rm(data, { recursive: true, force: true });
  });
  async function status() { try { return await (await fetch(`http://127.0.0.1:${httpPort}/api/status`)).json(); } catch { if (child.exitCode !== null) throw Error(output); return null; } }
  await until(async () => { const s = await status(); return s?.state.internal.status === 'connected' && s?.state.manufacturer.status === 'connected'; });
  const saved = JSON.parse(await fs.readFile(path.join(data, 'config.json')));
  assert.equal(saved.internalMqtt.enabled, true); assert.equal(saved.routerDnat, undefined);
  async function client(options) { const c = mqtt.connect({ reconnectPeriod: 0, ...options }); clients.push(c); await once(c, 'connect'); return c; }
  const observer = await client({ host: '127.0.0.1', port: localServer.address().port });
  const cloud = await client({ host: '127.0.0.1', port: manufacturerServer.address().port, protocol: 'mqtts', rejectUnauthorized: false });
  const deviceA = await client({ host: '127.0.0.1', port: devicePort, protocol: 'mqtts', rejectUnauthorized: false, clientId: 'DIV01-A' });
  const deviceB = await client({ host: '127.0.0.1', port: devicePort, protocol: 'mqtts', rejectUnauthorized: false, clientId: 'DIV01-B' });
  const nonDevices = [];
  for (const clientId of ['mqttjs-observer', 'purethink-bridge', 'DIV01-', 'DIV01-bad/level', 'DIV01-+', 'DIV01-#', 'DIV01-bad id', 'DIV01-trailing\n']) {
    nonDevices.push(await client({ host: '127.0.0.1', port: devicePort, protocol: 'mqtts', rejectUnauthorized: false, clientId }));
  }
  assert.equal((await status()).state.device.clientId, 'DIV01-B');
  const localMessages = []; const cloudMessages = []; const deviceMessages = [];
  observer.on('message', (topic, body) => localMessages.push([topic, body.toString()]));
  cloud.on('message', (topic, body) => cloudMessages.push([topic, body.toString()]));
  deviceA.on('message', (topic, body) => deviceMessages.push([topic, body.toString()]));
  await Promise.all([subscribe(observer, '/things/#'), subscribe(cloud, '/things/#'), subscribe(deviceA, '/things/DIV01-A/#')]);
  await until(() => Object.values(manufacturer.clients).some((c) => c.subscriptions['/things/DIV01-A/#'] && c.subscriptions['/things/DIV01-B/#']));
  const beforeObserver = (await status()).state.device;
  await publish(nonDevices[0], '/things/DIV01-A/command', 'observer-command');
  await until(() => localMessages.some(([, b]) => b === 'observer-command') && cloudMessages.some(([, b]) => b === 'observer-command'));
  assert.deepEqual((await status()).state.device, beforeObserver);
  assert.ok((await status()).state.bridge.messages.some((m) => m.direction === 'from-client' && m.payload === 'observer-command'));
  for (const connection of Object.values(manufacturer.clients)) {
    for (const nonDevice of nonDevices) assert.equal(connection.subscriptions[`/things/${nonDevice.options.clientId}/#`], undefined);
  }
  await publish(deviceA, '/things/DIV01-A/shadow', 'telemetry');
  await until(() => localMessages.some(([, b]) => b === 'telemetry') && cloudMessages.some(([, b]) => b === 'telemetry'));
  await publish(observer, '/things/DIV01-A/command', 'local-command');
  await until(() => deviceMessages.some(([, b]) => b === 'local-command') && cloudMessages.some(([, b]) => b === 'local-command'));
  await publish(cloud, '/things/DIV01-A/command', 'cloud-command');
  await until(() => deviceMessages.some(([, b]) => b === 'cloud-command') && localMessages.some(([, b]) => b === 'cloud-command'));
  assert.equal(deviceMessages.filter(([, b]) => b === 'local-command').length, 1);
  const bridgeCloud = Object.values(manufacturer.clients).find((c) => c.subscriptions['/things/DIV01-A/#']);
  bridgeCloud.close();
  await until(async () => (await status())?.state.manufacturer.status !== 'connected');
  deviceB.end(true);
  await until(async () => (await status())?.state.device.clientId === 'DIV01-A');
  await publish(observer, '/things/DIV01-A/command', 'offline-local-command');
  await until(() => deviceMessages.some(([, b]) => b === 'offline-local-command'));
  await until(() => Object.values(manufacturer.clients).some((c) => c !== bridgeCloud && c.subscriptions['/things/DIV01-A/#'] && !c.subscriptions['/things/DIV01-B/#']));
  const oldInternal = local.clients['purethink-bridge'];
  oldInternal.close();
  await until(() => local.clients['purethink-bridge'] && local.clients['purethink-bridge'] !== oldInternal);
  await until(async () => (await status())?.state.internal.status === 'connected');
  deviceB.end(true);
  await until(async () => (await status())?.state.device.clientId === 'DIV01-A');
  // Remaining app connections must not keep the physical device online.
  deviceA.end(true);
  await until(async () => (await status())?.state.device.status === 'offline');
  assert.equal((await status()).state.device.clientId, null);
  await publish(nonDevices[0], '/things/DIV01-A/command', 'observer-without-device');
  assert.equal((await status()).state.device.status, 'offline');
  assert.equal((await status()).state.device.clientId, null);
  for (const connection of nonDevices) connection.end(true);
  const registered = [
    { id: 'purethink-living', clientId: 'random-connection-1', name: '거실' },
    { id: 'AC01-office', clientId: 'random-connection-2', name: '사무실' }
  ];
  async function saveDevices(devices) {
    return fetch(`http://127.0.0.1:${httpPort}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ devices }) });
  }
  const manualA = await client({ host: '127.0.0.1', port: devicePort, protocol: 'mqtts', rejectUnauthorized: false, clientId: registered[0].clientId });
  const manualB = await client({ host: '127.0.0.1', port: devicePort, protocol: 'mqtts', rejectUnauthorized: false, clientId: registered[1].clientId });
  assert.equal((await saveDevices(registered)).status, 200);
  await until(async () => (await status()).state.devices.filter((d) => d.registered && d.status === 'connected').length === 2);
  await until(() => Object.values(manufacturer.clients).some((c) => c.subscriptions['/things/purethink-living/#'] && c.subscriptions['/things/AC01-office/#']));
  const manualMessages = [];
  manualA.on('message', (topic, body) => manualMessages.push([topic, body.toString()]));
  await subscribe(manualA, '/things/purethink-living/#');
  await publish(manualA, '/things/purethink-living/shadow', 'manual-telemetry');
  await until(() => localMessages.some(([, b]) => b === 'manual-telemetry') && cloudMessages.some(([, b]) => b === 'manual-telemetry'));
  await publish(cloud, '/things/purethink-living/command', 'manual-command');
  await until(() => manualMessages.some(([, b]) => b === 'manual-command'));
  assert.equal((await status()).state.devices.find((d) => d.id === registered[0].id).rx, 1);
  const captured = (await status()).state.bridge.mqttDiscovery.connections.find((c) => c.clientId === registered[0].clientId);
  assert.equal(captured.port, devicePort);
  assert.equal(captured.mode, 'mqtt-tls-terminated');
  assert.deepEqual(captured.deviceIds, [registered[0].id]);
  assert.equal((await saveDevices([registered[0], registered[0]])).status, 400);
  assert.deepEqual((await status()).config.devices, registered);
  // Removing a mapping drops its subscription immediately, keeping the other device.
  assert.equal((await saveDevices([registered[1]])).status, 200);
  await until(() => Object.values(manufacturer.clients).some((c) => !c.subscriptions['/things/purethink-living/#'] && c.subscriptions['/things/AC01-office/#']));
  assert.equal((await saveDevices(registered)).status, 200);
  manualA.end(true);
  await until(async () => (await status()).state.devices.find((d) => d.id === registered[0].id).status === 'offline');
  assert.equal((await status()).state.devices.find((d) => d.id === registered[1].id).status, 'connected');
  const manualAgain = await client({ host: '127.0.0.1', port: devicePort, protocol: 'mqtts', rejectUnauthorized: false, clientId: registered[0].clientId });
  await until(async () => (await status()).state.devices.find((d) => d.id === registered[0].id).status === 'connected');
  manualAgain.end(true); manualB.end(true);
  const previousConfig = await fs.readFile(path.join(data, 'config.json'), 'utf8');
  const invalid = await fetch(`http://127.0.0.1:${httpPort}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ internalMqtt: { port: -1 } }) });
  assert.equal(invalid.status, 400);
  assert.equal(await fs.readFile(path.join(data, 'config.json'), 'utf8'), previousConfig);
  assert.equal((await status()).state.internal.status, 'connected');
  const response = await fetch(`http://127.0.0.1:${httpPort}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ internalMqtt: { enabled: false, host: '', password: 'keep-secret' } }) });
  assert.equal(response.status, 200);
  assert.equal((await status()).config.internalMqtt.password, '********');
  assert.equal((await fetch(`http://127.0.0.1:${httpPort}/api/router-dnat/status`, { method: 'POST' })).status, 404);
  child.kill(); await once(child, 'exit');
  child = spawnBridge(); watch(child);
  await until(async () => (await status())?.state.internal.status === 'disabled');
  const restored = JSON.parse(await fs.readFile(path.join(data, 'config.json')));
  assert.equal(restored.internalMqtt.enabled, false);
  assert.equal(restored.internalMqtt.host, '');
  assert.equal(restored.internalMqtt.password, 'keep-secret');
  assert.deepEqual(restored.devices, registered);
  assert.equal((await status()).state.devices.filter((d) => d.registered && d.status === 'offline').length, 2);
});
