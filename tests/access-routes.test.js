import test from 'node:test';
import mqttPacket from 'mqtt-packet';
import { createMqttDiscovery } from '../src/mqtt-discovery.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createAccessLog } from '../src/access-log.js';
import { customTcpRoutes } from '../src/custom-routes.js';
import { createTcpProxy } from '../src/origin-proxy.js';

test('custom routes validate targets and reject local forwarding loops', () => {
  assert.deepEqual(customTcpRoutes('{"8883":{"host":"127.0.0.1","port":1884}}', [8883]), {8883:{host:'127.0.0.1',port:1884}});
  assert.throws(() => customTcpRoutes('{"8883":{"host":"127.0.0.1","port":443}}', [8883], [443]));
  for (const input of ['[]', 'null', '{"99":{"host":"127.0.0.1","port":1884}}', '{"8883":{"host":"dapt.iptime.org","port":8883}}', '{"8883":{"host":"127.0.0.1","port":8883}}']) assert.throws(() => customTcpRoutes(input, [8883]));
});

test('custom TCP destination bypasses origin DNS and records client port, traffic and bounded history', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-access-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const upstream = net.createServer((socket) => socket.pipe(socket));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => upstream.close());
  const log = createAccessLog({ directory, maxBytes: 800, limit: 3 });
  const discovery = createMqttDiscovery();
  const proxy = createTcpProxy({ port: 20622, onConnection(socket) { discovery.observe(socket, {port:20622,mode:'passthrough'}); }, target: {host:'127.0.0.1',port:upstream.address().port}, lookup() { assert.fail('Must not resolve origin for custom target'); } });
  log.observe(proxy, {port:20622,mode:'custom-tcp'});
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => proxy.close());
  const client = net.connect(proxy.address().port, '127.0.0.1');
  await once(client, 'connect');
  const frame = mqttPacket.generate({cmd:'connect',protocolVersion:4,clientId:'plain-captured',clean:true,keepalive:60});
  const data = once(client, 'data'); client.write(frame);
  assert.deepEqual((await data)[0], frame);
  assert.equal(discovery.state.connections[0].clientId, 'plain-captured');
  client.end(); await once(client, 'close');
  for (let i = 0; i < 50 && log.state.ports[20622].active; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.state.ports[20622].accepted, 1);
  assert.equal(log.state.ports[20622].active, 0);
  const closed = log.state.recent.find((e) => e.event === 'close');
  assert.equal(closed.bytesRead, frame.length); assert.equal(closed.remoteAddress, '127.0.0.1');
  assert.equal(closed.bytesWritten, frame.length);
  for (let i = 0; i < 15; i++) log.record({event:'upstream-error',port:20622,error:'refused'});
  assert.equal(log.state.recent.length, 3);
  assert.ok(fs.existsSync(path.join(directory, 'access.jsonl.1')));
  assert.ok(!fs.readFileSync(path.join(directory, 'access.jsonl'), 'utf8').includes('payload'));
});
