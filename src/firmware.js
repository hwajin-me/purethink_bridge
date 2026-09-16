import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { ORIGIN_HOST } from './origin.js';

export const ORIGINAL = 'ver.220706.1630_DIV01';
export const PATCHED = 'ver.220706.1633_DIV01';
export const SIZE = 509952;
export const HASHES = {
  [ORIGINAL]: '454d85f3b4e56b51ac7776df154a37bf684b5bf81f3a81a19721de3e70b66d97',
  [PATCHED]: '9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343'
};
export const VERSION_ROUTES = new Set(['/version/combined', '/api/firmwareversioncombined', '/api/getfirmwareversioncombined']);
export function isVersionRoute(url) {
  return VERSION_ROUTES.has(url.split('?')[0].toLowerCase().replace(/\/$/, ''));
}
export function verifyFirmware(version, bytes) {
  if (bytes.length !== SIZE || createHash('sha256').update(bytes).digest('hex') !== HASHES[version]) {
    throw new Error(`Invalid ${version} firmware: size/SHA256 mismatch`);
  }
  return bytes;
}
export function patchFirmware(original) {
  const fw = Buffer.from(verifyFirmware(ORIGINAL, original));
  const base = 0x1000;
  if (fw[base] !== 0xe9) throw new Error('Invalid ESP8266 image');
  let offset = 8;
  const segments = [];
  for (let index = 0; index < fw[base + 1]; index++) {
    const load = fw.readUInt32LE(base + offset);
    const size = fw.readUInt32LE(base + offset + 4);
    offset += 8;
    if (base + offset + size > fw.length) throw new Error('Segment out of bounds');
    segments.push({ load, size, start: base + offset });
    offset += size;
  }
  const matches = segments.filter(({ load, size }) => load <= 0x4020c82c && 0x4020c82c < load + size);
  if (matches.length !== 1) throw new Error('DIV01 patch location mismatch');
  const position = matches[0].start + 0x4020c82c - matches[0].load;
  if (!fw.subarray(position, position + 4).equals(Buffer.from('12c190c2', 'hex'))) throw new Error('DIV01 patch bytes mismatch');
  Buffer.from('0c020df0', 'hex').copy(fw, position);
  let count = 0;
  for (let at = fw.indexOf(ORIGINAL); at !== -1; at = fw.indexOf(ORIGINAL, at + ORIGINAL.length)) {
    fw.write(PATCHED, at, 'ascii'); count++;
  }
  if (count !== 2) throw new Error('DIV01 version string mismatch');
  let checksum = 0xef;
  for (const { start, size } of segments) for (const byte of fw.subarray(start, start + size)) checksum ^= byte;
  fw[base + (((offset + 16) & ~15) - 1)] = checksum;
  return verifyFirmware(PATCHED, fw);
}

export function downloadOriginal(lookup) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: ORIGIN_HOST, port: 6002, path: `/firmware/${ORIGINAL}.bin`,
      lookup, family: 4, agent: false }, (response) => {
      if (response.statusCode !== 200) {
        request.destroy(new Error(`Firmware download HTTP ${response.statusCode}`));
        return;
      }
      const chunks = []; let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > SIZE) request.destroy(new Error('Firmware exceeds expected size'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(verifyFirmware(ORIGINAL, Buffer.concat(chunks))); } catch (error) { reject(error); }
      });
    });
    // Covers DNS and connection establishment as well as response inactivity.
    const deadline = setTimeout(() => request.destroy(new Error('Firmware download timeout')), 30000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}

export function createFirmwareStore({ directory, lookup, download = () => downloadOriginal(lookup) }) {
  const images = new Map();
  const state = { directory, status: 'unavailable', available: [], lastError: null };
  let pending;
  const filename = (version) => path.join(directory, `${version}.bin`);
  const update = () => {
    state.available = [...images.keys()];
    state.status = images.has(PATCHED) ? 'ready' : 'unavailable';
  };
  async function load() {
    images.clear();
    state.lastError = null;
    for (const version of [ORIGINAL, PATCHED]) {
      try { images.set(version, verifyFirmware(version, await fs.readFile(filename(version)))); }
      catch (error) { if (error.code !== 'ENOENT') state.lastError = error.message; }
    }
    update();
  }
  async function write(version, data) {
    const temp = `${filename(version)}.${process.pid}.tmp`;
    try { await fs.writeFile(temp, data, { mode: 0o644 }); await fs.rename(temp, filename(version)); }
    finally { await fs.rm(temp, { force: true }); }
    images.set(version, data);
  }
  function prepare() {
    if (pending) return pending;
    pending = (async () => {
      state.status = 'preparing';
      try {
        await fs.mkdir(directory, { recursive: true });
        const original = images.get(ORIGINAL) || verifyFirmware(ORIGINAL, await download());
        // Verify the complete output before publishing either artifact.
        const patched = patchFirmware(original);
        if (!images.has(ORIGINAL)) await write(ORIGINAL, original);
        if (!images.has(PATCHED)) await write(PATCHED, patched);
        state.lastError = null;
      } catch (error) { state.lastError = error.message; throw error; }
      finally { update(); pending = null; }
    })();
    return pending;
  }
  function handle(req, res, localOta) {
    const route = req.url.split('?')[0];
    const version = [ORIGINAL, PATCHED].find((value) => route === `/firmware/${value}.bin`);
    const metadata = localOta && isVersionRoute(req.url);
    if (!version && !metadata) return false;
    // Uncached original remains available through the normal origin proxy.
    if (version === ORIGINAL && !images.has(ORIGINAL)) return false;
    const image = images.get(version || PATCHED);
    if (!image) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '60', 'Cache-Control': 'no-store' }).end('Verified DIV01 firmware is not ready\n');
      return true;
    }
    if (version && !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return true;
    }
    let content = image; let start = 0; let end = image.length - 1; let status = 200;
    const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: `"${HASHES[version]}"` };
    if (metadata) {
      const firmwarePath = `/firmware/${PATCHED}.bin`;
      content = Buffer.from(JSON.stringify({ LastVersionDiv: PATCHED, UpdateDate: '220706.1633',
        Hostname: ORIGIN_HOST, Port: 6002, PathDiv: firmwarePath, PathTestDiv: firmwarePath }));
      Object.assign(headers, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      delete headers.ETag; delete headers['Accept-Ranges'];
    } else if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === headers.ETag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        if (!match[1]) start = Math.max(0, image.length - Number(match[2]));
        else { start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end; }
      }
      if (!match || (!match[1] && !match[2]) || start > end || start >= image.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${image.length}` }).end(); return true;
      }
      content = image.subarray(start, end + 1); status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${image.length}`;
    }
    headers['Content-Length'] = content.length;
    req.resume();
    res.writeHead(status, headers).end(req.method === 'HEAD' ? undefined : content);
    return true;
  }
  return { state, load, prepare, handle };
}
