import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMirrorTracker } from '../src/mirror-tracker.js';
import { mergeInternalMqtt, writeConfig } from '../src/config.js';

test('identical MQTT publishes each consume one echo; older expiry cannot remove newer token', () => {
  let clock = 0;
  const tracker = createMirrorTracker({ now: () => clock });
  const payload = Buffer.from('same');
  tracker.remember('internal', '/things/a', payload);
  clock = 2000;
  tracker.remember('internal', '/things/a', payload);
  assert.equal(tracker.consume('internal', '/things/a', payload), true);
  clock = 5001;
  assert.equal(tracker.consume('internal', '/things/a', payload), true);
  assert.equal(tracker.consume('internal', '/things/a', payload), false);
  tracker.remember('internal', '/things/a', payload);
  tracker.clear('internal');
  assert.equal(tracker.consume('internal', '/things/a', payload), false);
});

test('MQTT mirror tracker expires and bounds total outstanding echoes', () => {
  let clock = 0;
  const tracker = createMirrorTracker({ now: () => clock, maxEntries: 2 });
  tracker.remember('m', '/a', Buffer.from('1'));
  tracker.remember('m', '/b', Buffer.from('2'));
  tracker.remember('m', '/c', Buffer.from('3'));
  assert.equal(tracker.consume('m', '/a', Buffer.from('1')), false);
  assert.equal(tracker.consume('m', '/b', Buffer.from('2')), true);
  clock = 5001;
  assert.equal(tracker.consume('m', '/c', Buffer.from('3')), false);
});

const valid = { enabled: true, host: 'localhost', port: 1883, username: '', password: 'secret', clientId: 'bridge', topic: '/things/#' };
test('invalid MQTT settings cannot be saved; password masking and explicit clearing', () => {
  for (const patch of [{ port: -1 }, { port: '1883' }, { port: 65536 }, { enabled: 'false' }, { host: null },
    { host: 'mqtt://foo' }, { topic: '/things/#/bad' }, { topic: '/things/dev+' }, { clientId: '' }, { username: 42 }]) {
    assert.throws(() => mergeInternalMqtt(valid, patch));
  }
  assert.equal(mergeInternalMqtt(valid, { password: '' }).password, 'secret');
  assert.equal(mergeInternalMqtt(valid, { password: '********' }).password, 'secret');
  assert.equal(mergeInternalMqtt(valid, { clearPassword: true }).password, '');
  assert.equal(mergeInternalMqtt(valid, { enabled: false, host: '' }).host, '');
});
test('config replacement is private even when previous file was public', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  try {
    const file = path.join(directory, 'config.json'); fs.writeFileSync(file, '{}', { mode: 0o644 });
    writeConfig(file, { internalMqtt: valid });
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { internalMqtt: valid });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
