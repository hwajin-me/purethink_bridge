import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRegistry, validateDevices } from '../src/devices.js';

test('manual device IDs have no model prefix restriction; reject ambiguous mappings and unsafe topics', () => {
  assert.deepEqual(validateDevices([{ id: 'purethink-거실' }]), [{ id: 'purethink-거실', clientId: 'purethink-거실', name: '' }]);
  for (const id of ['', 'bad/id', 'bad+', 'bad#', 'bad\n', 'bad\0']) assert.throws(() => validateDevices([{ id }]));
  for (const clientId of [42, false, null]) assert.throws(() => validateDevices([{ id: 'ok', clientId }]));
  assert.throws(() => validateDevices([{ id: 'a', clientId: 'same' }, { id: 'b', clientId: 'same' }]));
  assert.throws(() => validateDevices([{ id: 'a', clientId: 'one' }, { id: 'a', clientId: 'two' }]));
});

test('live mapping changes, session replacement and disconnects keep multiple device states separate', () => {
  const registry = createDeviceRegistry(() => 'now');
  const first = { id: 'random' }; const replacement = { id: 'random' };
  const second = { id: 'another' };
  registry.connect(first); registry.connect(second);
  assert.equal(registry.list().length, 0);
  registry.configure([{ id: 'actual-a', clientId: 'random' }, { id: 'actual-b', clientId: 'another' }]);
  assert.equal(registry.list().filter((d) => d.status === 'connected').length, 2);
  registry.connect(replacement); registry.disconnect(first);
  assert.equal(registry.forClient(replacement).status, 'connected');
  assert.equal(registry.forClient(first), null);
  registry.disconnect(second);
  assert.equal(registry.list().find((d) => d.id === 'actual-b').status, 'offline');
  assert.deepEqual([...registry.subscriptions()], ['actual-a', 'actual-b']);
  registry.configure([{ id: 'actual-b', clientId: 'another' }]);
  assert.equal(registry.forClient(replacement), null);
  assert.deepEqual([...registry.subscriptions()], ['actual-b']);
});
