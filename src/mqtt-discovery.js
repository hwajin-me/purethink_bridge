import { validDeviceId } from './devices.js';

const MORE = Symbol('incomplete');
const decoder = new TextDecoder('utf-8', { fatal: true });
function stringAt(buffer, offset) {
  if (offset + 2 > buffer.length) throw MORE;
  const size = buffer.readUInt16BE(offset);
  if (offset + 2 + size > buffer.length) throw MORE;
  const value = decoder.decode(buffer.subarray(offset + 2, offset + 2 + size));
  if (value.includes('\0')) throw new Error('Invalid MQTT string');
  return [value, offset + 2 + size];
}
function variableAt(buffer, offset) {
  let value = 0;
  for (let index = 0; index < 4; index++) {
    if (offset + index >= buffer.length) throw MORE;
    const byte = buffer[offset + index];
    value += (byte & 127) * 128 ** index;
    if (!(byte & 128)) return [value, offset + index + 1];
  }
  throw new Error('Invalid MQTT remaining length');
}
function skipProperties(buffer, offset) {
  const [size, start] = variableAt(buffer, offset);
  if (start + size > buffer.length) throw MORE;
  return start + size;
}

// Observe client -> server bytes only. Never alter, pause, consume or forward
// the stream here. Large PUBLISH bodies are skipped without buffering them.
export function createMqttInspector({ onConnect, onTopic, onOpaque = () => {}, onError = () => {}, maxPrefix = 131072 }) {
  let stopped = false, first = true, version, command, length = 0, multiplier = 1, lengthBytes = 0;
  let tlsProbe = null;
  let readingLength = false, remaining = 0, prefix = null, used = 0, decoded = false;
  function stop(reason) { stopped = true; prefix = null; if (reason) onError(reason); }
  function inspect(complete) {
    if (decoded || !prefix) return;
    const buffer = prefix.subarray(0, used);
    try {
      if (command === 0x10) {
        if (!first) throw new Error('Repeated CONNECT');
        const [protocol, next] = stringAt(buffer, 0);
        if (next + 4 > buffer.length) throw MORE;
        const level = buffer[next] & 127;
        if (!((protocol === 'MQTT' && [4, 5].includes(level)) || (protocol === 'MQIsdp' && level === 3)) || (buffer[next + 1] & 1)) throw new Error('Invalid MQTT CONNECT');
        let offset = next + 4;
        if (level === 5) offset = skipProperties(buffer, offset);
        const [clientId] = stringAt(buffer, offset);
        version = level;
        first = false;
        decoded = true;
        onConnect({ clientId, protocolVersion: level });
      } else if (command >> 4 === 3) {
        const [topic] = stringAt(buffer, 0);
        decoded = true;
        if (topic && !/[+#]/.test(topic)) onTopic({ topic, source: 'publish' });
      } else if (command === 0x82 && complete) {
        if (buffer.length < 2) throw MORE;
        let offset = version === 5 ? skipProperties(buffer, 2) : 2;
        const topics = [];
        while (offset < buffer.length) {
          const [topic, end] = stringAt(buffer, offset);
          if (end >= buffer.length) throw MORE;
          topics.push(topic); offset = end + 1;
        }
        decoded = true;
        for (const topic of topics) onTopic({ topic, source: 'subscribe' });
      }
    } catch (error) {
      if (error !== MORE || complete) stop(error === MORE ? 'Truncated MQTT metadata' : 'Invalid MQTT metadata');
    }
  }
  return {
    push(chunk) {
      let offset = 0;
      while (!stopped && offset < chunk.length) {
        if (tlsProbe) {
          tlsProbe.push(chunk[offset++]);
          if (tlsProbe.length === 5) {
            if (tlsProbe[1] === 3 && tlsProbe[2] <= 3 && (tlsProbe[3] || tlsProbe[4])) onOpaque({ reason: 'tls-passthrough' });
            stop();
          }
          continue;
        }
        if (command === undefined) {
          command = chunk[offset++];
          if (first && command !== 0x10) {
            if (command === 0x16) { tlsProbe = [command]; continue; }
            stop(); break;
          }
          length = 0; multiplier = 1; lengthBytes = 0; readingLength = true;
          remaining = 0; used = 0; decoded = false;
        }
        if (readingLength) {
          if (offset === chunk.length) break;
          const byte = chunk[offset++];
          length += (byte & 127) * multiplier; multiplier *= 128; lengthBytes++;
          if (byte & 128) { if (lengthBytes === 4) stop('Invalid MQTT remaining length'); continue; }
          readingLength = false; remaining = length;
          prefix = (command === 0x10 || command >> 4 === 3 || command === 0x82) ? Buffer.alloc(Math.min(length, maxPrefix)) : null;
        }
        const count = Math.min(remaining, chunk.length - offset);
        if (prefix && !decoded) {
          const take = Math.min(count, prefix.length - used);
          chunk.copy(prefix, used, offset, offset + take); used += take;
        }
        offset += count; remaining -= count;
        if (command === 0x82 && length > maxPrefix && used === maxPrefix) { stop('MQTT metadata exceeds capture limit'); break; }
        inspect(remaining === 0);
        if (prefix && !decoded && used === maxPrefix && remaining > 0) stop('MQTT metadata exceeds capture limit');
        if (decoded) prefix = null;
        if (remaining === 0) { command = undefined; prefix = null; }
      }
    },
    get stopped() { return stopped; }
  };
}

export function createMqttDiscovery({ record = () => {}, limit = 100 } = {}) {
  const state = { connections: [] };
  let sequence = 0;
  function observe(socket, metadata) {
    let entry;
    const peer = { port: metadata.port, mode: metadata.mode, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort };
    function add(values) {
      entry = { id: ++sequence, ...peer, connectedAt: new Date().toISOString(), active: true, topics: [], deviceIds: [], ...values };
      state.connections.push(entry);
      if (state.connections.length > limit) state.connections.shift();
      record({ event: 'mqtt-detected', ...peer, ...values });
    }
    const inspector = createMqttInspector({
      onConnect(values) { add({ ...values, status: 'identified' }); },
      onOpaque(values) { add({ ...values, status: 'encrypted' }); },
      onError(reason) {
        if (entry) entry.captureError = reason;
        else add({ status: 'unreadable', captureError: reason });
      },
      onTopic({ topic, source }) {
        if (!entry) return;
        const id = topic.startsWith('/things/') ? topic.split('/')[2] : null;
        if (!validDeviceId(id)) return;
        entry.lastSeen = new Date().toISOString();
        if (entry.topics.length < 20 && !entry.topics.some((item) => item.topic === topic && item.source === source)) {
          entry.topics.push({ topic, source });
          record({ event: 'mqtt-device-topic', ...peer, clientId: entry.clientId, deviceId: id, topic, source });
        }
        if (entry.deviceIds.length < 20 && !entry.deviceIds.includes(id)) entry.deviceIds.push(id);
      }
    });
    function data(chunk) { inspector.push(chunk); if (inspector.stopped) socket.off('data', data); }
    socket.on('data', data);
    socket.once('close', () => {
      socket.off('data', data);
      if (entry) { entry.active = false; entry.disconnectedAt = new Date().toISOString(); }
    });
  }
  return { state, observe };
}
