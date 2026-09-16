import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import mqttPacket from 'mqtt-packet';
import { createMqttInspector, createMqttDiscovery } from '../src/mqtt-discovery.js';

const connect = (version = 4, clientId = 'random-client') => mqttPacket.generate({ cmd: 'connect', protocolId: version === 3 ? 'MQIsdp' : 'MQTT', protocolVersion: version,
  clientId, clean: true, keepalive: 60, username: 'private-user', password: Buffer.from('private-password'),
  ...(version === 5 ? { properties: { sessionExpiryInterval: 60 } } : {}) });
const subscribe = (version = 4) => mqttPacket.generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: '/things/actual-one/#', qos: 0 }, { topic: '/things/other-two/shadow', qos: 1 }],
  ...(version === 5 ? { properties: { subscriptionIdentifier: 3 } } : {}) }, { protocolVersion: version });

test('reads MQTT 3.1/3.1.1/5 CONNECT and multiple topic candidates across byte fragments', () => {
  for (const version of [3, 4, 5]) {
    const identities = []; const topics = [];
    const inspector = createMqttInspector({ onConnect: (v) => identities.push(v), onTopic: (v) => topics.push(v), onError: (v) => assert.fail(v) });
    const publish = mqttPacket.generate({ cmd: 'publish', topic: '/things/actual-one/shadow', payload: Buffer.alloc(300000, 65), qos: 0 }, { protocolVersion: version });
    const first = connect(version);
    for (const byte of first) inspector.push(Buffer.from([byte]));
    inspector.push(Buffer.concat([publish, subscribe(version)]));
    assert.deepEqual(identities, [{ clientId: 'random-client', protocolVersion: version }]);
    assert.deepEqual(topics, [{ topic: '/things/actual-one/shadow', source: 'publish' }, { topic: '/things/actual-one/#', source: 'subscribe' }, { topic: '/things/other-two/shadow', source: 'subscribe' }]);
  }
});

test('empty original Client ID is reported faithfully; TLS and HTTP are never treated as MQTT IDs', () => {
  const identities = []; const opaque = [];
  const inspector = createMqttInspector({ onConnect: (v) => identities.push(v), onTopic() {} });
  inspector.push(connect(4, ''));
  assert.equal(identities[0].clientId, '');
  for (const input of [Buffer.from([0x16, 3, 3, 0, 10]), Buffer.from('GET / HTTP/1.1\r\n')]) {
    const parser = createMqttInspector({ onConnect: () => assert.fail('Not MQTT'), onTopic() {}, onOpaque: (v) => opaque.push(v) });
    for (const byte of input) parser.push(Buffer.from([byte]));
    assert.equal(parser.stopped, true);
  }
  assert.deepEqual(opaque, [{ reason: 'tls-passthrough' }]);
});

test('malformed frames and oversized metadata stop inspection without throwing', () => {
  for (const input of [Buffer.from([0x10, 255, 255, 255, 255]), Buffer.from([0x10, 1, 0]), connect(4, 'x'.repeat(200))]) {
    const errors = [];
    const parser = createMqttInspector({ maxPrefix: 32, onConnect() {}, onTopic() {}, onError: (v) => errors.push(v) });
    assert.doesNotThrow(() => parser.push(input));
    assert.equal(parser.stopped, true);
    assert.equal(errors.length, 1);
  }
});

test('capture history is bounded and excludes credentials and payloads', () => {
  const records = [];
  const discovery = createMqttDiscovery({ limit: 2, record: (v) => records.push(v) });
  for (let i = 0; i < 3; i++) {
    const socket = new PassThrough();
    socket.remoteAddress = '192.0.2.10'; socket.remotePort = 4000 + i;
    discovery.observe(socket, { port: 8885, mode: 'mqtt-tls-terminated' });
    socket.write(Buffer.concat([connect(), subscribe(), mqttPacket.generate({ cmd: 'publish', topic: '/things/actual-one/shadow', payload: 'private-body', qos: 0 })]));
    socket.emit('close');
  }
  assert.equal(discovery.state.connections.length, 2);
  const last = discovery.state.connections.at(-1);
  assert.equal(last.active, false);
  assert.equal(last.clientId, 'random-client');
  assert.deepEqual(last.deviceIds, ['actual-one', 'other-two']);
  assert.equal(last.remotePort, 4002);
  assert.doesNotMatch(JSON.stringify({ records, state: discovery.state }), /private-user|private-password|private-body/);
});
