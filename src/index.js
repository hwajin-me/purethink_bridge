import fs from 'node:fs';
import { createPortRouter } from './port-routing.js';
import { createMqttDiscovery } from './mqtt-discovery.js';
import { createDeviceRegistry, validateDevices } from './devices.js';
import path from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import { loadPortServices, createPortService } from './port-services.js';
import { createAccessLog } from './access-log.js';
import { customTcpRoutes } from './custom-routes.js';
import { loadCustomTls, tlsListeners } from './tls-config.js';
import { fileURLToPath } from 'node:url';

import Aedes from 'aedes';
import express from 'express';
import mqtt from 'mqtt';
import selfsigned from 'selfsigned';
import { createOriginLookup, DNS_SERVERS } from './origin.js';
import { createOriginProxy, createTcpProxy, originTcpPorts } from './origin-proxy.js';
import { createFirmwareStore } from './firmware.js';
import { validateRootCa } from './root-ca.js';
import { buildFirmware, validateBuildOptions } from './firmware-build.js';
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
const reservedPorts = [HTTP_PORT, DEVICE_MQTT_PORT, ORIGIN_HTTP_PORT, 16003];
const tlsConfig = tlsListeners(process.env, reservedPorts);
const customTls = loadCustomTls();
if ((tlsConfig.httpsPort || tlsConfig.dashboardPort) && !customTls) {
  throw new Error('HTTPS termination requires TLS_CERT_FILE and TLS_KEY_FILE');
}
const TCP_PORTS = originTcpPorts(process.env.ORIGIN_TCP_PORTS, reservedPorts)
  .filter((port) => port !== tlsConfig.httpsPort && port !== tlsConfig.httpPort);
const routes = tlsConfig.mode === 'terminate' ? customTcpRoutes(process.env.CUSTOM_TCP_ROUTES, TCP_PORTS,
  [HTTP_PORT, DEVICE_MQTT_PORT, ORIGIN_HTTP_PORT, tlsConfig.httpPort, tlsConfig.httpsPort, tlsConfig.dashboardPort]) : {};
if (TCP_PORTS.includes(tlsConfig.dashboardPort)) throw new Error('DASHBOARD_HTTPS_PORT conflicts with ORIGIN_TCP_PORTS');
const portServices = tlsConfig.mode === 'terminate' ? await loadPortServices(process.env.PORT_SERVICES_FILE,
  [...TCP_PORTS, DEVICE_MQTT_PORT, ORIGIN_HTTP_PORT, tlsConfig.httpPort, tlsConfig.httpsPort],
  [HTTP_PORT, tlsConfig.dashboardPort], [DEVICE_MQTT_PORT, ORIGIN_HTTP_PORT]) : {};

const MANUFACTURER = {
  host: 'dapt.iptime.org',
  port: 8885,
  protocol: 'mqtts',
  rejectUnauthorized: false
};

const DEFAULT_CONFIG = {
  version: 1,
  devices: [],
  portRouting: {},
  internalMqtt: {
    enabled: process.env.INTERNAL_MQTT_ENABLED === 'true',
    host: process.env.INTERNAL_MQTT_HOST || '',
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
    id: null,
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
    origin: { dnsServers: DNS_SERVERS, addresses: [], server: null, lastError: null, mqttPort: DEVICE_MQTT_PORT, httpPort: ORIGIN_HTTP_PORT, localOta: true }
  }
};

const accessLog = createAccessLog({ directory: path.join(DATA_DIR, 'logs') });
state.bridge.access = accessLog.state;
const mqttDiscovery = createMqttDiscovery({ record: accessLog.record });
state.bridge.mqttDiscovery = mqttDiscovery.state;
const observe = (server, port, mode) => accessLog.observe(server, { port, mode });
let config = DEFAULT_CONFIG;
let manufacturerClient = null;
let internalClient = null;
const recentMirrors = createMirrorTracker();
const manufacturerSubscriptions = new Set();
const devices = createDeviceRegistry(displayTime);
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
    devices: validateDevices(loaded.devices || []),
    portRouting: loaded.portRouting || {},
    internalMqtt: { ...DEFAULT_CONFIG.internalMqtt, ...(loaded.internalMqtt || {}) }
  };
  if (loaded.routerDnat || loaded.version !== 1 || loaded.devices?.some((device) => Object.hasOwn(device, 'clientId'))) saveConfig(migrated);
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

function topicForDevice(deviceId) {
  return `/things/${deviceId}/#`;
}

function subscribeManufacturerForDevice(deviceId) {
  if (!deviceId || !manufacturerClient?.connected) return;
  const topic = topicForDevice(deviceId);
  if (manufacturerSubscriptions.has(topic)) return;
  const client = manufacturerClient;
  client.subscribe(topic, { qos: 0 }, (err, granted) => {
    if (client !== manufacturerClient) return;
    if (!devices.subscriptions().has(deviceId)) {
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
    for (const device of devices.list()) {
      if (topic.startsWith(`/things/${device.id}/`)) device.tx += 1;
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
    for (const deviceId of devices.subscriptions()) subscribeManufacturerForDevice(deviceId);
  });

  client.on('message', (topic, payload, packet) => {
    if (manufacturerClient !== client) return;
    if (!topicMatchesThings(topic)) return;
    if (wasMirroredTo('manufacturer', topic, payload)) return;
    if (devices.manufacturerMessage(topic, { retain: Boolean(packet?.retain) })) refreshDevices();
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
  const previousClient = internalClient;
  internalClient = null;
  if (previousClient) previousClient.end(true);
  state.internal.lastError = null;
  recentMirrors.clear('internal');

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

function refreshDevices() {
  state.devices = devices.list();
  const connected = state.devices.filter((device) => device.status === 'connected');
  state.device.status = connected.length ? 'connected' : 'offline';
  state.device.localConnected = connected.some((device) => device.localConnected);
  state.device.id = connected.at(-1)?.id || null;
  const wanted = devices.subscriptions();
  for (const topic of manufacturerSubscriptions) {
    if (!wanted.has(topic.slice('/things/'.length, -2))) {
      manufacturerSubscriptions.delete(topic);
      if (manufacturerClient?.connected) manufacturerClient.unsubscribe(topic);
    }
  }
  for (const id of wanted) subscribeManufacturerForDevice(id);
}
devices.configure(config.devices);
refreshDevices();

aedes.on('client', (client) => {
  devices.connect(client);
  refreshDevices();
});

aedes.on('subscribe', (subscriptions, client) => {
  devices.subscribe(client, subscriptions.map((item) => item.topic));
  refreshDevices();
});
aedes.on('unsubscribe', (topics, client) => {
  devices.unsubscribe(client, topics);
  refreshDevices();
});

aedes.on('clientDisconnect', (client) => {
  devices.disconnect(client);
  refreshDevices();
});

aedes.on('publish', (packet, client) => {
  if (!client) return;
  if (!topicMatchesThings(packet.topic)) return;
  const device = devices.localMessage(client, packet.topic, { retain: Boolean(packet.retain) });
  if (device) {
    state.device.status = 'connected';
    state.device.id = device.id;
    state.device.lastSeen = displayTime();
    state.device.lastTopic = packet.topic;
    state.device.rx += 1;
    refreshDevices();
  }
  state.bridge.rx += 1;
  recordMessage(device ? 'from-device' : 'from-client', packet.topic, packet.payload);
  publishToManufacturer(packet.topic, packet.payload);
  publishToInternal(packet.topic, packet.payload);
});

const tlsOptions = customTls?.options || ensureCertificate();
state.bridge.tls = { ...tlsConfig, custom: Boolean(customTls), ...customTls?.info };
const serviceServers = {};
for (const [port, serviceConfig] of Object.entries(portServices)) {
  serviceServers[port] = await createPortService({ config: serviceConfig, tlsOptions, lookup: origin.lookup,
    onConnection: (socket) => mqttDiscovery.observe(socket, { port: Number(port), mode: `${serviceConfig.mode}-${serviceConfig.transport}` }),
    context: { log: (event) => accessLog.record({ ...event, port: Number(port), mode: 'simulate' }) },
    onError: (error, socket) => {
      accessLog.record({ event: 'service-error', port: Number(port), error: error.message, remoteAddress: socket?.remoteAddress, remotePort: socket?.remotePort });
      state.bridge.lastError = `Port ${port}: ${error.message}`;
      const service = state.bridge.origin.tcpServices?.find((entry) => entry.port === Number(port));
      if (service) service.lastError = error.message;
    }
  });
}
{ // The device MQTT listener is always owned by Bridge.
  const mqttServer = observe(tls.createServer(tlsOptions, (socket) => {
    mqttDiscovery.observe(socket, { port: DEVICE_MQTT_PORT, mode: 'mqtt-tls-terminated' });
    aedes.handle(socket);
  }), DEVICE_MQTT_PORT, 'mqtt');
  mqttServer.listen(DEVICE_MQTT_PORT, DEVICE_MQTT_HOST, () => {
    console.log(`Device MQTT/TLS listening on ${DEVICE_MQTT_HOST}:${DEVICE_MQTT_PORT}`);
  });
}
connectManufacturer();
connectInternal();

const app = express();
app.use(express.json());
app.get('/tls/root-ca.crt', (_req, res) => {
  if (!customTls?.rootCa) return res.status(404).end();
  res.set('Content-Type', 'application/x-x509-ca-cert').send(customTls.rootCa);
});
if (tlsConfig.dashboardPort) {
  observe(https.createServer(tlsOptions, app), tlsConfig.dashboardPort, 'dashboard-tls').on('error', (error) => { console.error(error); process.exit(1); })
    .listen(tlsConfig.dashboardPort, DEVICE_MQTT_HOST);
}
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', (_req, res) => {
  refreshDevices();
  res.json({
    state,
    config: {
      devices: config.devices,
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
    const next = {
      ...config,
      devices: Object.hasOwn(req.body || {}, 'devices') ? validateDevices(req.body.devices) : config.devices,
      internalMqtt: Object.hasOwn(req.body || {}, 'internalMqtt') ? mergeInternalMqtt(config.internalMqtt, req.body.internalMqtt) : config.internalMqtt
    };
    saveConfig(next);
    config = next;
    devices.configure(config.devices);
    refreshDevices();
    if (Object.hasOwn(req.body || {}, 'internalMqtt')) connectInternal();
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

observe(app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`Dashboard listening on 0.0.0.0:${HTTP_PORT}`);
}), HTTP_PORT, 'dashboard');

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
app.post('/api/firmware/validate-root-ca', (req, res) => {
  try {
    const { info } = validateRootCa(req.body?.rootCaPem, req.body?.expectedRootCaFingerprint);
    res.set('Cache-Control', 'no-store').json({ ok: true, rootCa: info });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.post('/api/firmware/build', (req, res) => {
  try { validateBuildOptions(req.body); }
  catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
  if (!firmware.state.available.includes('ver.220706.1630_DIV01')) {
    return res.status(409).json({ ok: false, error: 'Prepare / Retry DIV01 Firmware first' });
  }
  try {
    res.set('Cache-Control', 'no-store').json({ ok: true, ...buildFirmware(firmware.getOriginal(), req.body) });
  } catch (error) { res.status(422).json({ ok: false, error: error.message }); }
});
const proxyError = (error) => { state.bridge.origin.lastError = error.message; };
{ // The firmware/HTTP listener is always owned by Bridge.
  const originHttp = createOriginProxy({ lookup: origin.lookup, localOta: true,
    firmware, onError: proxyError });
  observe(originHttp, ORIGIN_HTTP_PORT, 'origin-http').listen(ORIGIN_HTTP_PORT, DEVICE_MQTT_HOST, () => {
    console.log(`Origin HTTP proxy listening on ${DEVICE_MQTT_HOST}:${ORIGIN_HTTP_PORT}`);
  });
}
const routingPorts = [...TCP_PORTS, ...[tlsConfig.httpPort, tlsConfig.httpsPort].filter(Boolean)];
const legacyRoutes = {};
for (const port of routingPorts) {
  if (serviceServers[port]) legacyRoutes[port] = { server: serviceServers[port], mode: `${portServices[port].mode}-${portServices[port].transport}` };
  else if (port === tlsConfig.httpPort || port === tlsConfig.httpsPort) legacyRoutes[port] = {
    mode: port === tlsConfig.httpsPort ? 'custom-https' : 'custom-http',
    server: createOriginProxy({ lookup: origin.lookup, localOta: LOCAL_OTA_ENABLED, firmware,
      ...(port === tlsConfig.httpsPort ? { tlsOptions } : {}), onError: proxyError })
  };
  else if (routes[port]) legacyRoutes[port] = { mode: 'custom-tcp', server: createTcpProxy({ port, target: routes[port], onError: proxyError }) };
}
const portRouter = createPortRouter({ ports: routingPorts,
  reserved: [...reservedPorts, tlsConfig.dashboardPort].filter(Boolean), tlsOptions, lookup: origin.lookup,
  accessLog, discovery: mqttDiscovery, legacy: legacyRoutes });
(await portRouter.prepare(config.portRouting)).commit();
state.bridge.origin.tcpPorts = routingPorts;
state.bridge.origin.tcpServices = portRouter.services;
await portRouter.listen(DEVICE_MQTT_HOST);
app.get('/api/ports', (_req, res) => res.json({
  fixed: [{ port: ORIGIN_HTTP_PORT, mode: 'bridge-http' }, { port: DEVICE_MQTT_PORT, mode: 'bridge-mqtt' }],
  ports: portRouter.entries()
}));
let routingUpdate = false;
app.post('/api/ports', async (req, res) => {
  if (routingUpdate) return res.status(409).json({ error: 'Another port update is in progress' });
  routingUpdate = true;
  try {
    if (!req.body?.portRouting || typeof req.body.portRouting !== 'object' || Array.isArray(req.body.portRouting)) throw Error('portRouting must be an object');
    const prepared = await portRouter.prepare({ ...config.portRouting, ...req.body.portRouting });
    const next = { ...config, portRouting: prepared.clean };
    saveConfig(next);
    config = next;
    prepared.commit();
    accessLog.record({ event: 'routing-updated', ports: Object.keys(req.body.portRouting) });
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
  finally { routingUpdate = false; }
});
