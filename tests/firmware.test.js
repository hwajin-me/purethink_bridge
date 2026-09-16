import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createFirmwareStore, patchFirmware, verifyFirmware, ORIGINAL, PATCHED, SIZE, HASHES } from '../src/firmware.js';
import { createOriginProxy } from '../src/origin-proxy.js';

// Deterministic ESP8266 fixture with the same layout constraints as the production
// image. Test-only hashes are scoped to this worker; real-image hashes are verified
// separately by the installer smoke test and firmware:prepare against the origin.
const original = Buffer.alloc(SIZE);
const base = 0x1000, start = base + 16, size = 0x10000;
original[base] = 0xe9; original[base + 1] = 1;
original.writeUInt32LE(0x40200000, base + 8); original.writeUInt32LE(size, base + 12);
Buffer.from('12c190c2', 'hex').copy(original, start + 0xc82c);
original.write(ORIGINAL, start + 100); original.write(ORIGINAL, start + 200);
const expected = Buffer.from(original);
Buffer.from('0c020df0', 'hex').copy(expected, start + 0xc82c);
expected.write(PATCHED, start + 100); expected.write(PATCHED, start + 200);
let checksum = 0xef;
for (const byte of expected.subarray(start, start + size)) checksum ^= byte;
expected[base + (((16 + size + 16) & ~15) - 1)] = checksum;
const hash = (data) => createHash('sha256').update(data).digest('hex');
HASHES[ORIGINAL] = hash(original); HASHES[PATCHED] = hash(expected);

test('DIV01 patch verifies input, exact patch bytes, version strings and checksum', () => {
  assert.deepEqual(patchFirmware(original), expected);
  const corrupt = Buffer.from(original); corrupt[40] = 1;
  assert.throws(() => patchFirmware(corrupt), /SHA256/);
  assert.throws(() => verifyFirmware(PATCHED, original), /SHA256/);
});

test('firmware is available offline, ranges/HEAD work, metadata waits for verification', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-test-'));
  let downloads = 0; let online = false;
  const store = createFirmwareStore({ directory, download: async () => {
    downloads++; if (!online) throw Error('Origin offline'); return original;
  } });
  await store.load();
  const proxy = createOriginProxy({ firmware: store, localOta: true, lookup: (_host, _opts, cb) => cb(Error('Origin offline')) });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const url = `http://127.0.0.1:${proxy.address().port}`;
  t.after(async () => { proxy.closeAllConnections(); proxy.close(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(`${url}/version/combined`)).status, 503);
  assert.equal((await fetch(`${url}/firmware/${PATCHED}.bin`)).status, 503);
  await assert.rejects(store.prepare(), /offline/);
  assert.equal(store.state.status, 'unavailable');
  online = true;
  await Promise.all([store.prepare(), store.prepare()]); assert.equal(downloads, 2);
  assert.equal(store.state.status, 'ready');
  const metadata = await (await fetch(`${url}/api/FirmwareVersionCombined`)).json();
  assert.equal(metadata.LastVersionDiv, PATCHED);
  for (const version of [ORIGINAL, PATCHED]) {
    const response = await fetch(`${url}/firmware/${version}.bin`);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), HASHES[version]);
    const head = await fetch(`${url}/firmware/${version}.bin`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(SIZE)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const partial = await fetch(`${url}/firmware/${PATCHED}.bin`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 100-199/${SIZE}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected.subarray(100, 200));
  for (const range of ['bytes=999999-', 'bytes=-0', 'bytes=4-2']) {
    assert.equal((await fetch(`${url}/firmware/${PATCHED}.bin`, { headers: { Range: range } })).status, 416);
  }
  assert.equal((await fetch(`${url}/unrelated/FirmwareVersionCombinedExtra`)).status, 502);
  assert.equal((await fetch(`${url}/firmware/other-model.bin`)).status, 502);
  const restarted = createFirmwareStore({ directory, download: async () => { throw Error('Must remain offline'); } });
  await restarted.load(); await restarted.prepare(); assert.equal(restarted.state.status, 'ready');
  const normal = createOriginProxy({ firmware: restarted, lookup: (_host, _opts, cb) => cb(Error('Origin offline')) });
  normal.listen(0, '127.0.0.1'); await once(normal, 'listening');
  t.after(() => { normal.closeAllConnections(); normal.close(); });
  const normalUrl = `http://127.0.0.1:${normal.address().port}`;
  assert.equal((await fetch(`${normalUrl}/firmware/${PATCHED}.bin`)).status, 200);
  assert.equal((await fetch(`${normalUrl}/version/combined`)).status, 502);
});

test('corrupt firmware is not advertised or served', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-corrupt-'));
  try {
    await fs.writeFile(path.join(directory, `${PATCHED}.bin`), Buffer.alloc(SIZE));
    const store = createFirmwareStore({ directory, download: async () => Buffer.alloc(SIZE) });
    await store.load(); assert.equal(store.state.status, 'unavailable');
    await assert.rejects(store.prepare(), /SHA256/); assert.deepEqual(store.state.available, []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
