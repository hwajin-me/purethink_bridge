import { createHash } from 'node:crypto';
import { ORIGINAL, PATCHED, HASHES, patchFirmware } from './firmware.js';

import { validateRootCa } from './root-ca.js';

export const ORIGINAL_HOST = 'dapt.iptime.org';
export const HOST_SLOTS = [
  { offset: 0x7bcfb, value: 'http://dapt.iptime.org:6002/atmospheric/device?mac=%d' },
  { offset: 0x7bd35, value: 'http://dapt.iptime.org:6002/device/fwVersion?mac=%d' },
  { offset: 0x7c303, value: ORIGINAL_HOST }
];

export function patchHostname(bytes, hostname) {
  for (const { offset, value } of HOST_SLOTS) {
    const expected = Buffer.from(value + '\0');
    if (!bytes.subarray(offset, offset + expected.length).equals(expected)) throw Error('DIV01 hostname layout mismatch');
  }
  for (const { offset, value } of HOST_SLOTS) {
    const replacement = value.replace(ORIGINAL_HOST, hostname);
    bytes.fill(0, offset, offset + value.length + 1);
    bytes.write(replacement, offset, 'ascii');
  }
  return HOST_SLOTS.map(({ offset }) => offset);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateBuildOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('Build options must be an object');
  const { version = 'ver.220706.1634_DIV01', rootCaPem = '' } = options;
  if (typeof version !== 'string' || !/^ver\.220706\.\d{4}_DIV01$/.test(version) || Number(version.slice(11, 15)) <= 1633) {
    throw Error('Version must be ver.220706.NNNN_DIV01 with NNNN greater than 1633');
  }
  if (options.tlsMode !== 'bypass') throw Error('Only the verified DIV01 TLS bypass patch is supported; CA trust embedding is unavailable');
  if (typeof rootCaPem !== 'string' || Buffer.byteLength(rootCaPem) > 16384) throw Error('Root CA PEM must be at most 16 KiB');
  const hostname = options.hostname ?? ORIGINAL_HOST;
  if (typeof hostname !== 'string' || hostname.length > 15 || !hostname.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label))) {
    throw Error('Hostname must be an ASCII DNS name or IPv4 address, at most 15 bytes, without scheme, port or path');
  }
  if (/^[0-9.]+$/.test(hostname) && (hostname.split('.').length !== 4 || hostname.split('.').some((part) => Number(part) > 255 || (part.length > 1 && part[0] === '0')))) throw Error('Invalid IPv4 address');
  if (options.expectedRootCaFingerprint && !rootCaPem.trim()) throw Error('Provide a Root CA to check its fingerprint');
  const validation = rootCaPem.trim() ? validateRootCa(rootCaPem, options.expectedRootCaFingerprint) : null;
  return { version, hostname: hostname.toLowerCase(), root: validation?.root, rootInfo: validation?.info || null };
}

export function buildFirmware(original, options) {
  const { version, hostname, root, rootInfo } = validateBuildOptions(options);
  const bytes = Buffer.from(patchFirmware(original));
  let count = 0;
  for (let at = bytes.indexOf(PATCHED); at !== -1; at = bytes.indexOf(PATCHED, at + PATCHED.length)) {
    bytes.write(version, at, 'ascii'); count++;
  }
  if (count !== 2) throw Error('DIV01 version string mismatch');
  const hostnameOffsets = hostname === ORIGINAL_HOST ? [] : patchHostname(bytes, hostname);
  const base = 0x1000;
  let offset = 8, checksum = 0xef;
  for (let i = 0; i < bytes[base + 1]; i++) {
    const size = bytes.readUInt32LE(base + offset + 4);
    offset += 8;
    for (const byte of bytes.subarray(base + offset, base + offset + size)) checksum ^= byte;
    offset += size;
  }
  const checksumOffset = base + (((offset + 16) & ~15) - 1);
  bytes[checksumOffset] = checksum;
  return {
    filename: `${version}.bin`, firmwareBase64: bytes.toString('base64'),
    rootCaPem: root?.toString() || null,
    manifest: { model: 'DIV01', version, source: ORIGINAL, sourceSha256: HASHES[ORIGINAL],
      size: bytes.length, sha256: sha256(bytes), checksumOffset, checksum,
      tlsMode: 'bypass', caEmbedded: false, hostname, hostnameOffsets,
      rootCa: rootInfo,
      warning: 'TLS certificate verification is bypassed. Root CA is a companion file only; it is not embedded or trusted by the device. Custom version has not been verified on hardware.' }
  };
}
