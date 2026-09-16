import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import Aedes from 'aedes';
import express from 'express';
import mqtt from 'mqtt';
import selfsigned from 'selfsigned';
import { createOriginLookup, DNS_SERVERS } from './origin.js';
import { createOriginProxy, createTcpProxy } from './origin-proxy.js';
import { createFirmwareStore } from './firmware.js';
import { createMirrorTracker } from './mirror-tracker.js';
import { mergeInternalMqtt, validateInternalMqtt, writeConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const HTTP_PORT = Number(process.env.HTTP_PORT || 33301);
const DEVICE_MQTT_PORT = Number(process.env.DEVICE_MQTT_PORT || 8885);
const DEVICE_MQTT_HOST = process.env.DEVICE_MQTT_HOST || '0.0.0.0';
const DEVICE_MQTT_DISPLAY_HOST = process.env.DEVICE_MQTT_DISPLAY_HOST || DEVICE_MQTT_HOST;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CERT_DIR = path.join(DATA_DIR, 'certs');
const DISPLAY_TIME_ZONE = process.env.TZ || 'Asia/Seoul';
const ORIGIN_HTTP_PORT = Number(process.env.ORIGIN_HTTP_PORT || 6002);
const LOCAL_OTA_ENABLED = process.env.LOCAL_OTA_ENABLED === 'true';

const MANUFACTURER = {
  host: 'dapt.iptime.org',
  port: 8885,
  protocol: 'mqtts',
  rejectUnauthorized: false
};

const DEFAULT_CONFIG = {
  version: 1,
  internalMqtt: {
    enabled: process.env.INTERNAL_MQTT_ENABLED !== 'false',
    host: process.env.INTERNAL_MQTT_HOST || '127.0.0.1',
    port: 1883,
    username: '',
    password: '',
    clientId: 'purethink-bridge',
    topic: '/things/#'
  }
};

function displayTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}년 ${Number(value.month)}월 ${Number(value.day)}일\n${value.hour}:${value.minute}:${value.second}`;
}

const state = {
  startedAt: displayTime(),
  device: {
    status: 'offline',
    clientId: null,
    lastSeen: null,
    lastTopic: null,
    rx: 0,
    tx: 0
  },
  manufacturer: {
    status: 'offline',
    host: `${MANUFACTURER.host}:${MANUFACTURER.port}`,
    lastConnected: null,
    lastError: null,
    rx: 0,
    tx: 0
  },
  internal: {
    status: 'disabled',
    lastConnected: null,
    lastError: null,
    rx: 0,
    tx: 0
  },
  bridge: {
    host: `${DEVICE_MQTT_DISPLAY_HOST}:${DEVICE_MQTT_PORT}`,
    rx: 0,
    tx: 0,
    droppedLoopMessages: 0,
    lastError: null,
    messageSeq: 0,
    messages: [],
    origin: { dnsServers: DNS_SERVERS, addresses: [], server: null, lastError: null, mqttPort: DEVICE_MQTT_PORT, httpPort: ORIGIN_HTTP_PORT, localOta: LOCAL_OTA_ENABLED }
  }
};

let config = DEFAULT_CONFIG;
let manufacturerClient = null;
let internalClient = null;
const recentMirrors = createMirrorTracker();
const manufacturerSubscriptions = new Set();
const deviceClients = new Map();
const origin = createOriginLookup({ onUpdate: (update) => Object.assign(state.bridge.origin, update) });

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
  }
  const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const migrated = {
    ...DEFAULT_CONFIG,
    internalMqtt: { ...DEFAULT_CONFIG.internalMqtt, ...(loaded.internalMqtt || {}) }
  };
  // Old releases saved a disabled, empty placeholder. Preserve explicit broker choices.
  if (loaded.version !== 1 && !loaded.internalMqtt?.host) migrated.internalMqtt = { ...migrated.internalMqtt, host: DEFAULT_CONFIG.internalMqtt.host, enabled: DEFAULT_CONFIG.internalMqtt.enabled };
  if (loaded.routerDnat || loaded.version !== 1) saveConfig(migrated);
  return migrated;
}

function saveConfig(nextConfig) {
  ensureDir(DATA_DIR);
  writeConfig(CONFIG_PATH, { ...nextConfig, version: 1 });
}

function ensureCertificate() {
  ensureDir(CERT_DIR);
  const keyPath = path.join(CERT_DIR, 'server.key');
  const certPath = path.join(CERT_DIR, 'server.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const attrs = [{ name: 'commonName', value: 'dapt.iptime.org' }];
    const pems = selfsigned.generate(attrs, {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256'
    });
    fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
    fs.writeFileSync(certPath, pems.cert);
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
}

function topicMatchesThings(topic) {
  return topic.startsWith('/things/');
}

function topicForClient(clientId) {
  return `/things/${clientId}/#`;
}

function subscribeManufacturerForClient(clientId) {
  if (!clientId || !manufacturerClient?.connected) return;
  const topic = topicForClient(clientId);
  if (manufacturerSubscriptions.has(topic)) return;
  const client = manufacturerClient;
  client.subscribe(topic, { qos: 0 }, (err, granted) => {
    if (client !== manufacturerClient) return;
    if (!deviceClients.has(clientId)) {
      client.unsubscribe(topic);
      return;
    }
    if (err || granted?.some((entry) => entry.qos === 128)) {
      state.manufacturer.lastError = err?.message || `MQTT subscription denied: ${topic}`;
      return;
    }
    manufacturerSubscriptions.add(topic);
  });
}

function payloadText(payload) {
  const text = Buffer.from(payload).toString('utf8');
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function recordMessage(direction, topic, payload) {
  state.bridge.messageSeq += 1;
  state.bridge.messages.push({
    id: state.bridge.messageSeq,
    at: displayTime(),
    direction,
    topic,
    bytes: Buffer.byteLength(payload),
    payload: payloadText(payload)
  });
  if (state.bridge.messages.length > 200) {
    state.bridge.messages.splice(0, state.bridge.messages.length - 200);
  }
}

function rememberMirror(target, topic, payload) {
  recentMirrors.remember(target, topic, payload);
}

function wasMirroredTo(target, topic, payload) {
  if (!recentMirrors.consume(target, topic, payload)) return false;
  state.bridge.droppedLoopMessages += 1;
  return true;
}

function publishToDevice(topic, payload) {
  recordMessage('to-device', topic, payload);
  aedes.publish({ topic, payload, qos: 0, retain: false }, (err) => {
    if (err) {
      state.bridge.lastError = `device publish failed: ${err.message}`;
      return;
    }
    state.device.tx += 1;
    state.bridge.tx += 1;
  });
}

function publishToManufacturer(topic, payload) {
  if (!manufacturerClient?.connected) return;
  recordMessage('to-manufacturer', topic, payload);
  rememberMirror('manufacturer', topic, payload);
  manufacturerClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
    if (err) {
      state.manufacturer.lastError = err.message;
      return;
    }
    state.manufacturer.tx += 1;
  });
}

function publishToInternal(topic, payload) {
  if (!internalClient?.connected) return;
  recordMessage('to-internal', topic, payload);
  rememberMirror('internal', topic, payload);
  internalClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
    if (err) {
      state.internal.lastError = err.message;
      return;
    }
    state.internal.tx += 1;
  });
}

function connectManufacturer() {
  if (manufacturerClient) {
    manufacturerClient.end(true);
  }

  state.manufacturer.status = 'reconnecting';
  const client = manufacturerClient = mqtt.connect({
    protocol: MANUFACTURER.protocol,
    host: MANUFACTURER.host,
    servername: MANUFACTURER.host,
    lookup: origin.lookup,
    family: 4,
    port: MANUFACTURER.port,
    rejectUnauthorized: MANUFACTURER.rejectUnauthorized,
    protocolVersion: 4,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clean: true,
    resubscribe: false
  });

  client.on('connect', () => {
    if (manufacturerClient !== client) return;
    recentMirrors.clear('manufacturer');
    state.manufacturer.status = 'connected';
    state.manufacturer.lastConnected = displayTime();
    state.manufacturer.lastError = null;
    manufacturerSubscriptions.clear();
    for (const clientId of deviceClients.keys()) subscribeManufacturerForClient(clientId);
  });

  client.on('message', (topic, payload) => {
    if (manufacturerClient !== client) return;
    if (!topicMatchesThings(topic)) return;
    if (wasMirroredTo('manufacturer', topic, payload)) return;
    state.manufacturer.rx += 1;
    recordMessage('from-manufacturer', topic, payload);
    publishToDevice(topic, payload);
    publishToInternal(topic, payload);
  });

  client.on('reconnect', () => {
    if (manufacturerClient !== client) return;
    state.manufacturer.status = 'reconnecting';
  });

  client.on('close', () => {
    if (manufacturerClient !== client) return;
    if (state.manufacturer.status !== 'reconnecting') {
      state.manufacturer.status = 'offline';
    }
  });

  client.on('error', (err) => {
    if (manufacturerClient !== client) return;
    state.manufacturer.status = 'reconnecting';
    state.manufacturer.lastError = err.message;
  });
}

function connectInternal() {
  if (internalClient) {
    internalClient.end(true);
    internalClient = null;
  }

  if (!config.internalMqtt.enabled) {
    state.internal.status = 'disabled';
    return;
  }

  if (!config.internalMqtt.host) {
    state.internal.status = 'misconfigured';
    state.internal.lastError = 'Internal MQTT host is empty';
    return;
  }

  state.internal.status = 'reconnecting';
  const options = {
    protocol: 'mqtt',
    host: config.internalMqtt.host,
    port: Number(config.internalMqtt.port || 1883),
    clientId: config.internalMqtt.clientId || 'purethink-bridge',
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clean: true
  };
  if (config.internalMqtt.username) options.username = config.internalMqtt.username;
  if (config.internalMqtt.password) options.password = config.internalMqtt.password;

  const client = internalClient = mqtt.connect(options);

  client.on('connect', () => {
    if (internalClient !== client) return;
    recentMirrors.clear('internal');
    state.internal.status = 'connected';
    state.internal.lastConnected = displayTime();
    state.internal.lastError = null;
    client.subscribe(config.internalMqtt.topic || '/things/#', { qos: 0 }, (error, granted) => {
      if (client !== internalClient) return;
      if (error || granted?.some((entry) => entry.qos === 128)) {
        state.internal.status = 'subscription-error';
        state.internal.lastError = error?.message || 'MQTT subscription denied';
      }
    });
  });

  client.on('message', (topic, payload) => {
    if (internalClient !== client) return;
    if (!topicMatchesThings(topic)) return;
    if (wasMirroredTo('internal', topic, payload)) return;
    state.internal.rx += 1;
    recordMessage('from-internal', topic, payload);
    publishToDevice(topic, payload);
    publishToManufacturer(topic, payload);
  });

  client.on('reconnect', () => {
    if (internalClient !== client) return;
    state.internal.status = 'reconnecting';
  });

  client.on('close', () => {
    if (internalClient !== client) return;
    if (state.internal.status !== 'reconnecting') {
      state.internal.status = 'offline';
    }
  });

  client.on('error', (err) => {
    if (internalClient !== client) return;
    state.internal.status = 'reconnecting';
    state.internal.lastError = err.message;
  });
}

config = loadConfig();
validateInternalMqtt(config.internalMqtt);
const aedes = new Aedes();

aedes.on('client', (client) => {
  deviceClients.set(client.id, client);
  state.device.status = 'connected';
  state.device.clientId = client?.id || null;
  state.device.lastSeen = displayTime();
  subscribeManufacturerForClient(state.device.clientId);
});

aedes.on('clientDisconnect', (client) => {
  if (deviceClients.get(client?.id) !== client) return;
  deviceClients.delete(client?.id);
  const topic = topicForClient(client?.id);
  manufacturerSubscriptions.delete(topic);
  if (manufacturerClient?.connected) manufacturerClient.unsubscribe(topic);
  if (state.device.clientId === client?.id) {
    state.device.clientId = [...deviceClients.keys()].at(-1) || null;
    state.device.status = deviceClients.size ? 'connected' : 'offline';
    state.device.lastSeen = displayTime();
  }
});

aedes.on('publish', (packet, client) => {
  if (!client) return;
  if (!topicMatchesThings(packet.topic)) return;
  state.device.status = 'connected';
  state.device.clientId = client.id;
  state.device.lastSeen = displayTime();
  state.device.lastTopic = packet.topic;
  state.device.rx += 1;
  state.bridge.rx += 1;
  recordMessage('from-device', packet.topic, packet.payload);
  publishToManufacturer(packet.topic, packet.payload);
  publishToInternal(packet.topic, packet.payload);
});

const tlsOptions = ensureCertificate();
const mqttServer = tls.createServer(tlsOptions, aedes.handle);
mqttServer.listen(DEVICE_MQTT_PORT, DEVICE_MQTT_HOST, () => {
  console.log(`Device MQTT/TLS listening on ${DEVICE_MQTT_HOST}:${DEVICE_MQTT_PORT}`);
});

connectManufacturer();
connectInternal();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', (_req, res) => {
  res.json({
    state,
    config: {
      internalMqtt: {
        ...config.internalMqtt,
        password: config.internalMqtt.password ? '********' : ''
      }
    }
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    ...config,
    internalMqtt: {
      ...config.internalMqtt,
      password: ''
    }
  });
});

app.post('/api/config', (req, res) => {
  try {
    const next = { internalMqtt: mergeInternalMqtt(config.internalMqtt, req.body?.internalMqtt) };
    saveConfig(next);
    config = next;
    connectInternal();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/reconnect/manufacturer', (_req, res) => {
  connectManufacturer();
  res.json({ ok: true });
});

app.post('/api/reconnect/internal', (_req, res) => {
  connectInternal();
  res.json({ ok: true });
});

app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`Dashboard listening on 0.0.0.0:${HTTP_PORT}`);
});

const firmware = createFirmwareStore({
  directory: process.env.FIRMWARE_DIR || (fs.existsSync('/var/lib/purethink-ota/firmware')
    ? '/var/lib/purethink-ota/firmware' : path.join(DATA_DIR, 'firmware')),
  lookup: origin.lookup
});
state.bridge.firmware = firmware.state;
await firmware.load();
const prepareFirmware = () => firmware.prepare().catch((error) => console.error(error.message));
if (process.env.FIRMWARE_AUTO_PREPARE !== 'false') {
  void prepareFirmware();
  setInterval(() => {
    if (firmware.state.available.length < 2) void prepareFirmware();
  }, 60000).unref();
}
app.post('/api/firmware/prepare', async (_req, res) => {
  try { await firmware.prepare(); res.json({ ok: true, firmware: firmware.state }); }
  catch (error) { res.status(502).json({ ok: false, error: error.message, firmware: firmware.state }); }
});
const proxyError = (error) => { state.bridge.origin.lastError = error.message; };
const originHttp = createOriginProxy({ lookup: origin.lookup, localOta: LOCAL_OTA_ENABLED,
  firmware, onError: proxyError });
originHttp.listen(ORIGIN_HTTP_PORT, DEVICE_MQTT_HOST, () => {
  console.log(`Origin HTTP proxy listening on ${DEVICE_MQTT_HOST}:${ORIGIN_HTTP_PORT}`);
});
const extraPorts = [...new Set((process.env.ORIGIN_TCP_PORTS || '').split(',').filter(Boolean).map(Number))];
for (const port of extraPorts) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || [HTTP_PORT, DEVICE_MQTT_PORT, ORIGIN_HTTP_PORT, Number(process.env.LOCAL_OTA_PORT || 6003)].includes(port)) {
    throw new Error(`Invalid or conflicting ORIGIN_TCP_PORTS port: ${port}`);
  }
  createTcpProxy({ port, lookup: origin.lookup, onError: proxyError }).listen(port, DEVICE_MQTT_HOST);
}
state.bridge.origin.tcpPorts = extraPorts;
