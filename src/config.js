import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export function validateInternalMqtt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('internalMqtt must be an object');
  if (typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean');
  for (const field of ['host', 'username', 'password', 'clientId', 'topic']) {
    if (typeof value[field] !== 'string' || value[field].includes('\0') || Buffer.byteLength(value[field]) > 65535) throw new Error(`${field} must be a string without NUL`);
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('port must be an integer from 1 to 65535');
  if (value.enabled && !value.host.trim()) throw new Error('MQTT host is required');
  if (/\s|[/?#]/.test(value.host) || value.host.includes('://')) throw new Error('Use a hostname/IP, not a URL');
  if (value.host.includes(':') && !net.isIP(value.host)) throw new Error('MQTT port must be set in the port field');
  if (!value.clientId || Buffer.byteLength(value.clientId) > 65535) throw new Error('Invalid MQTT clientId');
  if (!value.topic || Buffer.byteLength(value.topic) > 65535) throw new Error('Invalid subscription topic');
  const levels = value.topic.split('/');
  if (levels.some((level, index) => (level.includes('#') && (level !== '#' || index !== levels.length - 1)) ||
    (level.includes('+') && level !== '+'))) throw new Error('Invalid MQTT topic wildcard');
  return value;
}
export function mergeInternalMqtt(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('internalMqtt must be an object');
  const next = { ...current };
  for (const key of ['enabled', 'host', 'port', 'username', 'password', 'clientId', 'topic']) {
    if (Object.hasOwn(patch, key)) next[key] = patch[key];
  }
  if (patch.password === '' || patch.password === '********') next.password = current.password;
  if (patch.clearPassword === true) next.password = '';
  return validateInternalMqtt(next);
}
export function writeConfig(filename, config) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally { fs.rmSync(temp, { force: true }); }
}
