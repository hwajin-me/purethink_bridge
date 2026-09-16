// Device identity comes from /things/<device ID>/..., never MQTT Client ID.
export function validDeviceId(id) {
  return typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 65520 && !/[/+#\s\u0000]/u.test(id);
}
function topicDevice(topic, shadowOnly = false) {
  const match = (shadowOnly ? /^\/things\/([^/]+)\/shadow$/ : /^\/things\/([^/]+)\//).exec(topic);
  return match && validDeviceId(match[1]) ? match[1] : null;
}
export function validateDevices(devices) {
  if (!Array.isArray(devices) || devices.length > 100) throw new Error('devices must be an array of up to 100 devices');
  const ids = new Set();
  return devices.map((device) => {
    if (!device || !validDeviceId(device.id)) throw new Error('Device ID must be a non-empty MQTT topic level without spaces or wildcards');
    if (ids.has(device.id)) throw new Error('Device IDs must be unique');
    if (device.name !== undefined && (typeof device.name !== 'string' || device.name.length > 100)) throw new Error('Device name must be at most 100 characters');
    ids.add(device.id);
    // Drop legacy Client ID mappings during loading and saving.
    return { id: device.id, name: device.name || '' };
  });
}

export function createDeviceRegistry(now, { clock = Date.now, activityTtlMs = 90000 } = {}) {
  let configured = [];
  // Key by connection object, so anonymous/changing IDs and concurrent sessions
  // never overwrite one another. A session can report several device topics.
  const sessions = new Map();
  const entries = new Map();
  const manufacturerActivity = new Map();
  function ensure(id) {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, status: 'offline', lastSeen: null, lastTopic: null, rx: 0, tx: 0 };
      entries.set(id, entry);
    }
    const manual = configured.find((device) => device.id === id);
    entry.name = manual?.name || ''; entry.registered = Boolean(manual);
    return entry;
  }
  function wantedIds() {
    const ids = new Set(configured.map((device) => device.id));
    for (const session of sessions.values()) {
      for (const topic of session.topics) { const id = topicDevice(topic); if (id) ids.add(id); }
      for (const id of session.published) ids.add(id);
    }
    return ids;
  }
  function reconcile() {
    const wanted = wantedIds();
    for (const [id, entry] of entries) {
      if (!wanted.has(id) && entry.registered) { entries.delete(id); manufacturerActivity.delete(id); }
      else { entry.status = 'offline'; entry.localConnected = false; entry.connection = 'offline'; }
    }
    for (const id of wanted) ensure(id);
    for (const session of sessions.values()) {
      for (const id of session.published) {
        const entry = ensure(id);
        entry.status = 'connected'; entry.localConnected = true; entry.connection = 'direct';
      }
    }
    for (const [id, seenAt] of manufacturerActivity) {
      if (clock() - seenAt >= activityTtlMs) { manufacturerActivity.delete(id); continue; }
      const entry = entries.get(id);
      if (entry && !entry.localConnected) { entry.status = 'connected'; entry.connection = 'manufacturer'; }
    }
  }
  function received(entry, topic) {
    entry.lastSeen = now(); entry.lastTopic = topic; entry.rx++;
    reconcile();
    return entry;
  }
  return {
    manufacturerMessage(topic, { retain = false } = {}) {
      const id = topicDevice(topic, true);
      const entry = entries.get(id);
      if (!entry || retain) return false;
      manufacturerActivity.set(id, clock());
      received(entry, topic);
      return true;
    },
    localMessage(client, topic, { retain = false } = {}) {
      const session = sessions.get(client); const id = topicDevice(topic, true);
      if (!session || !id || retain) return null;
      session.published.add(id);
      return received(ensure(id), topic);
    },
    configure(devices) { configured = validateDevices(devices); reconcile(); },
    connect(client) { sessions.set(client, { topics: new Set(), published: new Set() }); },
    subscribe(client, topics) {
      const session = sessions.get(client); if (!session) return;
      for (const topic of topics) session.topics.add(topic);
      reconcile();
    },
    unsubscribe(client, topics) {
      const session = sessions.get(client); if (!session) return;
      for (const topic of topics) session.topics.delete(topic);
      reconcile();
    },
    disconnect(client) { sessions.delete(client); reconcile(); },
    list() { reconcile(); return [...entries.values()]; },
    subscriptions() { return wantedIds(); }
  };
}
