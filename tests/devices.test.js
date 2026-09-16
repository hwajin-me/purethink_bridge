import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRegistry, validateDevices } from '../src/devices.js';

test('device config ignores legacy Client IDs and validates only actual device IDs and names', () => {
  assert.deepEqual(validateDevices([{ id: 'purethink-거실', clientId: 'obsolete' }]), [{ id: 'purethink-거실', name: '' }]);
  for (const id of ['', 'bad/id', 'bad+', 'bad#', 'bad\n', 'bad\0']) assert.throws(() => validateDevices([{ id }]));
  assert.equal(validateDevices([{ id: 'a', clientId: 'same' }, { id: 'b', clientId: 'same' }]).length, 2);
  assert.throws(() => validateDevices([{ id: 'a' }, { id: 'a' }]));
});

test('topic identity supports anonymous, changing and concurrent Client IDs and multiple devices per session', () => {
  const registry = createDeviceRegistry(() => 'now');
  const first = { id: '' }; const replacement = { id: 'different-id' }; const second = { id: '' };
  registry.configure([{ id: 'actual-a' }, { id: 'actual-b' }]);
  registry.connect(first); registry.connect(second);
  registry.subscribe(first, ['/things/actual-a/shadow', '/things/actual-b/#']);
  assert.equal(registry.list().filter((d) => d.status === 'connected').length, 0);
  assert.equal(registry.localMessage(first, '/things/actual-a/command'), null);
  registry.localMessage(first, '/things/actual-a/shadow');
  registry.localMessage(first, '/things/actual-b/shadow');
  assert.equal(registry.list().filter((d) => d.status === 'connected').length, 2);
  registry.connect(replacement);
  registry.localMessage(replacement, '/things/actual-a/shadow');
  registry.disconnect(first);
  assert.equal(registry.list().find((d) => d.id === 'actual-a').status, 'connected');
  assert.equal(registry.list().find((d) => d.id === 'actual-b').status, 'offline');
  registry.localMessage(second, '/things/actual-b/shadow');
  assert.equal(registry.list().find((d) => d.id === 'actual-b').status, 'connected');
  assert.deepEqual([...registry.subscriptions()], ['actual-a', 'actual-b']);
  registry.disconnect(replacement); registry.disconnect(second);
  assert.equal(registry.list().filter((d) => d.status === 'connected').length, 0);
});

test('subscriptions discover topic IDs without declaring subscribers online', () => {
  const registry = createDeviceRegistry(() => 'now');
  const client = { id: 'DIV01-wrong' };
  registry.connect(client);
  assert.equal(registry.list().length, 0);
  registry.subscribe(client, ['/things/AC01-real/#', '/things/+/shadow', '/things/#']);
  assert.deepEqual([...registry.subscriptions()], ['AC01-real']);
  assert.equal(registry.list()[0].status, 'offline');
  registry.unsubscribe(client, ['/things/AC01-real/#']);
  assert.equal(registry.subscriptions().size, 0);
});

test('live manufacturer shadow marks registered device online, expires, and never implies a direct connection', () => {
  let time = 1000;
  const registry = createDeviceRegistry(() => `seen-${time}`, { clock: () => time, activityTtlMs: 90000 });
  registry.configure([{ id: 'DIV01-07CF58' }, { id: 'another' }]);
  const device = () => registry.list().find((d) => d.id === 'DIV01-07CF58');
  assert.equal(device().status, 'offline');
  assert.equal(registry.manufacturerMessage('/things/DIV01-07CF58/shadow', { retain: true }), false);
  assert.equal(registry.manufacturerMessage('/things/DIV01-07CF58/command'), false);
  assert.equal(registry.manufacturerMessage('/things/unknown/shadow'), false);
  assert.equal(device().status, 'offline');
  assert.equal(registry.manufacturerMessage('/things/DIV01-07CF58/shadow'), true);
  assert.equal(device().status, 'connected');
  assert.equal(device().connection, 'manufacturer');
  assert.equal(device().localConnected, false);
  assert.equal(device().lastSeen, 'seen-1000');
  assert.equal(device().lastTopic, '/things/DIV01-07CF58/shadow');
  assert.equal(device().rx, 1);
  assert.equal(registry.list().find((d) => d.id === 'another').status, 'offline');
  time += 15000;
  registry.manufacturerMessage('/things/DIV01-07CF58/shadow');
  time += 89999;
  assert.equal(device().status, 'connected');
  registry.manufacturerMessage('/things/DIV01-07CF58/shadow', { retain: true });
  time++;
  assert.equal(device().status, 'offline');
  assert.equal(device().rx, 2);
  assert.equal(device().lastSeen, 'seen-16000');
  const local = { id: '' };
  registry.connect(local);
  registry.localMessage(local, '/things/DIV01-07CF58/shadow');
  time += 100000;
  assert.equal(device().status, 'connected');
  assert.equal(device().connection, 'direct');
  assert.equal(device().localConnected, true);
});
