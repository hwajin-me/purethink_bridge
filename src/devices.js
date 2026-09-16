// Device IDs are topic identifiers; MQTT connection IDs can be different.
export function validDeviceId(id) {
  return typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 65520 && !/[/+#\s\u0000]/u.test(id);
}

export function validateDevices(devices) {
  if (!Array.isArray(devices) || devices.length > 100) throw new Error('devices must be an array of up to 100 devices');
  const ids = new Set(); const clients = new Set();
  return devices.map((device) => {
    if (!device || !validDeviceId(device.id)) throw new Error('Device ID must be a non-empty MQTT topic level without spaces or wildcards');
    const clientId = device.clientId === undefined || device.clientId === '' ? device.id : device.clientId;
    if (typeof clientId !== 'string' || !clientId || clientId.includes('\0') || Buffer.byteLength(clientId) > 65535) throw new Error('Invalid device MQTT Client ID');
    if (ids.has(device.id) || clients.has(clientId)) throw new Error('Device IDs and MQTT Client IDs must be unique');
    if (device.name !== undefined && (typeof device.name !== 'string' || device.name.length > 100)) throw new Error('Device name must be at most 100 characters');
    ids.add(device.id); clients.add(clientId);
    return { id: device.id, clientId, name: device.name || '' };
  });
}

export function createDeviceRegistry(now) {
  let configured = [];
  const connections = new Map();
  const entries = new Map();
  function definition(clientId) {
    const manual = configured.find((device) => device.clientId === clientId);
    if (manual) return manual;
    if (validDeviceId(clientId) && clientId.startsWith('DIV01-') && clientId.length > 6 && !configured.some((device) => device.id === clientId)) {
      return { id: clientId, clientId, name: '' };
    }
  }
  function ensure(device) {
    let entry = entries.get(device.id);
    if (!entry) {
      entry = { id: device.id, status: 'offline', lastSeen: null, lastTopic: null, rx: 0, tx: 0 };
      entries.set(device.id, entry);
    }
    Object.assign(entry, device, { registered: configured.some((item) => item.id === device.id) });
    return entry;
  }
  function reconcile() {
    const wanted = new Map(configured.map((device) => [device.id, device]));
    for (const client of connections.values()) {
      const device = definition(client.id);
      if (device) wanted.set(device.id, device);
    }
    for (const [id, entry] of entries) {
      if (!wanted.has(id) && entry.registered) entries.delete(id);
      else entry.status = 'offline';
    }
    for (const device of wanted.values()) ensure(device);
    for (const client of connections.values()) {
      const device = definition(client.id);
      if (device) ensure(device).status = 'connected';
    }
  }
  return {
    configure(devices) { configured = validateDevices(devices); reconcile(); },
    connect(client) { connections.set(client.id, client); reconcile(); const device = this.forClient(client); if (device) device.lastSeen = now(); },
    disconnect(client) {
      if (connections.get(client.id) !== client) return;
      const device = this.forClient(client);
      if (device) device.lastSeen = now();
      connections.delete(client.id); reconcile();
    },
    forClient(client) {
      if (connections.get(client.id) !== client) return null;
      const device = definition(client.id);
      return device ? entries.get(device.id) : null;
    },
    list() { return [...entries.values()]; },
    clientIds() { return [...connections.keys()]; },
    subscriptions() { return new Set(this.list().filter((device) => device.registered || device.status === 'connected').map((device) => device.id)); }
  };
}
