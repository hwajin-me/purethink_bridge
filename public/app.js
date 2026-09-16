const $ = (id) => document.getElementById(id);
let hiddenUntilMessageId = 0;
let discoveredConnections = [];

function setStatus(id, value) {
  const el = $(id);
  el.textContent = value || '-';
  el.className = value || '';
}

function setText(id, value) {
  $(id).textContent = value || '-';
}

function setTime(id, value) {
  const el = $(id);
  el.textContent = value || '-';
  el.classList.add('time');
}

function counts(obj) {
  return `${obj.rx || 0} / ${obj.tx || 0}`;
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function renderMessages(messages) {
  const stream = $('payloadStream');
  const visible = messages
    .filter((message) => message.id > hiddenUntilMessageId)
    .slice()
    .reverse();
  stream.innerHTML = visible.map((message) => `
    <div class="payload-row">
      <div class="payload-meta">
        <span class="time">${escapeText(message.at)}</span>
        <b class="${escapeText(message.direction)}">${escapeText(message.direction)}</b>
        <span>${escapeText(message.topic)}</span>
        <span>${message.bytes || 0} bytes</span>
      </div>
      <pre>${escapeText(message.payload)}</pre>
    </div>
  `).join('');
  stream.scrollTop = 0;
}

async function loadStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  const { state, config } = data;

  setText('summary', `Local control: ${state.device.status === 'connected' && state.internal.status === 'connected' ? 'Available' : 'Check connections'}`);

  setStatus('deviceStatus', state.device.status);
  $('deviceList').innerHTML = (state.devices || []).map((device) => `
    <div class="device-status">
      <b>${escapeText(device.name || device.id)}</b> · <span>${escapeText(device.status)}</span>
      <dl>
        <dt>기기 ID</dt><dd>${escapeText(device.id)}</dd>
        <dt>MQTT Client ID</dt><dd>${escapeText(device.clientId)}</dd>
        <dt>등록 방식</dt><dd>${device.registered ? '직접 등록' : '자동 인식'}</dd>
        <dt>Last Seen</dt><dd class="time">${escapeText(device.lastSeen || '-')}</dd>
        <dt>Last Topic</dt><dd>${escapeText(device.lastTopic || '-')}</dd>
        <dt>RX / TX</dt><dd>${counts(device)}</dd>
      </dl>
    </div>`).join('') || '<p>등록하거나 연결된 기기가 없습니다.</p>';
  $('mqttClients').textContent = (state.mqttClients || []).join(', ') || '없음';
  $('mqttClientOptions').innerHTML = (state.mqttClients || []).map((id) => `<option value="${escapeText(id)}"></option>`).join('');

  discoveredConnections = state.bridge.mqttDiscovery?.connections || [];
  // Preserve an in-progress candidate selection across status polling.
  const selections = new Map([...$('mqttDiscovery').querySelectorAll('select')].map((select) => [select.dataset.connection, select.value]));
  $('mqttDiscovery').innerHTML = discoveredConnections.slice().reverse().map((entry) => `
    <div class="mqtt-detection" data-connection="${entry.id}">
      <b>${entry.status === 'encrypted' ? 'TLS passthrough · MQTT/ID 확인 불가' : entry.status === 'unreadable' ? 'MQTT 분석 불가' : escapeText(entry.clientId || '(빈 Client ID · 서버 할당 요청)')}</b>
      <p>${escapeText(entry.remoteAddress || '-')}:${entry.remotePort || '-'} → :${entry.port} · ${escapeText(entry.mode)} · ${entry.active ? '연결 중' : '종료'}${entry.protocolVersion ? ` · MQTT ${entry.protocolVersion === 4 ? '3.1.1' : entry.protocolVersion === 3 ? '3.1' : '5'}` : ''}</p>
      <p>연결 시각: ${escapeText(entry.connectedAt)}${entry.captureError ? ` · ${escapeText(entry.captureError)}` : ''}</p>
      <p>기기 ID 후보: ${entry.deviceIds.map(escapeText).join(', ') || '아직 관찰되지 않음'}</p>
      ${entry.topics.map((item) => `<div><code>${escapeText(item.source)} ${escapeText(item.topic)}</code></div>`).join('')}
      ${entry.status === 'identified' && entry.clientId ? `<div class="device-actions">
        ${entry.deviceIds.length > 1 ? `<select aria-label="등록할 기기 ID 후보" data-connection="${entry.id}"><option value="">기기 ID 후보 선택</option>${entry.deviceIds.map((id) => `<option value="${escapeText(id)}" ${selections.get(String(entry.id)) === id ? 'selected' : ''}>${escapeText(id)}</option>`).join('')}</select>` : ''}
        <button type="button" data-register="${entry.id}">등록 입력란에 추가</button>
      </div>` : ''}
    </div>`).join('') || '<p>아직 탐지된 연결이 없습니다. 기기나 앱을 다시 연결해 주세요.</p>';

  setStatus('manufacturerStatus', state.manufacturer.status);
  setText('manufacturerHost', state.manufacturer.host || '-');
  setTime('manufacturerConnected', state.manufacturer.lastConnected);
  setText('manufacturerError', state.manufacturer.lastError);
  setText('manufacturerCounts', counts(state.manufacturer));

  setStatus('internalStatus', state.internal.status);
  setText('internalHost', config.internalMqtt.host ? `${config.internalMqtt.host}:${config.internalMqtt.port}` : '-');
  setTime('internalConnected', state.internal.lastConnected);
  setText('internalError', state.internal.lastError);
  setText('internalCounts', counts(state.internal));

  setStatus('localControl', state.device.status === 'connected' && state.internal.status === 'connected' ? 'available' : 'limited');
  const access = state.bridge.access;
  setText('portAccess', access ? Object.entries(access.ports).map(([port, stats]) => `${port}: ${stats.accepted} connections / ${stats.active} active / ${stats.mode}`).join('\n') + '\n\n' + access.recent.slice(-40).reverse().map((event) => `${event.time} :${event.port} ${event.event} ${event.remoteAddress || ''} ${event.error || ''}`).join('\n') : '-');
  setText('bridgeHost', state.bridge.host);
  setTime('startedAt', state.startedAt);
  setText('bridgeCounts', counts(state.bridge));
  setText('droppedLoops', String(state.bridge.droppedLoopMessages || 0));
  setText('bridgeError', state.bridge.lastError);
  const origin = state.bridge.origin;
  setText('originAddresses', origin.addresses.join(', '));
  setText('originDns', origin.server);
  const https = origin.tcpServices?.find((service) => service.port === 443);
  setText('originHttps', state.bridge.tls?.mode === 'terminate' ? `TLS termination :${state.bridge.tls.httpsPort} · custom certificate` : https ? `${https.status} · ${https.connections} connections${https.lastError ? ` · ${https.lastError}` : ''}` : 'Disabled — enable ORIGIN_TCP_PORTS=80,443');
  setText('originError', origin.lastError);
  setText('originPorts', [origin.mqttPort, origin.httpPort, ...(origin.tcpPorts || [])].join(', '));
  setText('originOta', origin.localOta ? 'DIV01 patch enabled' : 'Manufacturer passthrough');
  setText('firmwareStatus', state.bridge.firmware?.status);
  setText('firmwareAvailable', state.bridge.firmware?.available.join(', '));
  setText('firmwareError', state.bridge.firmware?.lastError);
  renderMessages(state.bridge.messages || []);
}

async function loadConfig() {
  const res = await fetch('/api/config');
  const cfg = await res.json();
  $('deviceRows').replaceChildren();
  for (const device of cfg.devices || []) addDeviceRow(device);
  $('enabled').checked = Boolean(cfg.internalMqtt.enabled);
  $('host').value = cfg.internalMqtt.host || '';
  $('port').value = cfg.internalMqtt.port || 1883;
  $('username').value = cfg.internalMqtt.username || '';
  $('password').value = '';
  $('clientId').value = cfg.internalMqtt.clientId || 'purethink-bridge';
  $('topic').value = cfg.internalMqtt.topic || '/things/#';
}

async function saveConfig(event) {
  event.preventDefault();
  const body = {
    internalMqtt: {
      enabled: $('enabled').checked,
      host: $('host').value.trim(),
      port: Number($('port').value || 1883),
      username: $('username').value,
      password: $('password').value,
      clearPassword: $('clearPassword').checked,
      clientId: $('clientId').value.trim() || 'purethink-bridge',
      topic: $('topic').value.trim() || '/things/#'
    },
  };
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '설정 저장 실패');
  $('password').value = '';
  $('clearPassword').checked = false;
  setText('configMessage', '저장했습니다.');
  await loadStatus();
}

async function post(path) {
  await fetch(path, { method: 'POST' });
  await loadStatus();
}

$('refresh').addEventListener('click', loadStatus);
$('configForm').addEventListener('submit', (event) => {
  saveConfig(event).catch((error) => setText('configMessage', error.message));
});
$('reconnectManufacturer').addEventListener('click', () => post('/api/reconnect/manufacturer'));
$('reconnectInternal').addEventListener('click', () => post('/api/reconnect/internal'));
$('clearPayloads').addEventListener('click', async () => {
  const res = await fetch('/api/status');
  const data = await res.json();
  const messages = data.state.bridge.messages || [];
  hiddenUntilMessageId = messages.at(-1)?.id || 0;
  renderMessages([]);
});

loadConfig().then(loadStatus);
setInterval(loadStatus, 3000);

$('prepareFirmware').addEventListener('click', async () => {
  $('prepareFirmware').disabled = true;
  try {
    const response = await fetch('/api/firmware/prepare', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Firmware preparation failed');
  } catch (error) { setText('firmwareError', error.message); }
  finally { $('prepareFirmware').disabled = false; await loadStatus(); }
});

function addDeviceRow(device = {}) {
  const row = document.createElement('div');
  row.className = 'device-row';
  row.innerHTML = `
    <label>이름 (선택)<input data-field="name" maxlength="100" value="${escapeText(device.name || '')}" placeholder="거실"></label>
    <label>기기 ID<input data-field="id" required value="${escapeText(device.id || '')}" placeholder="실제 기기 ID"></label>
    <label>MQTT 접속 Client ID (다를 때)<input data-field="clientId" list="mqttClientOptions" value="${escapeText(device.clientId === device.id ? '' : device.clientId || '')}" placeholder="비우면 기기 ID 사용"></label>
    <button type="button">삭제</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('deviceRows').append(row);
}
$('addDevice').addEventListener('click', () => addDeviceRow());
$('devicesForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const devices = [...$('deviceRows').children].map((row) => Object.fromEntries(
      [...row.querySelectorAll('input')].map((input) => [input.dataset.field, input.value.trim()])
    ));
    const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ devices }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '기기 저장 실패');
    setText('devicesMessage', '기기 목록을 저장했습니다.');
    await loadStatus();
  } catch (error) { setText('devicesMessage', error.message); }
  finally { if (button) button.disabled = false; }
});

$('mqttDiscovery').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-register]');
  if (!button) return;
  const entry = discoveredConnections.find((item) => item.id === Number(button.dataset.register));
  if (!entry?.clientId) return;
  const select = button.closest('.mqtt-detection').querySelector('select');
  if (select && !select.value) { select.focus(); return; }
  const id = select?.value || entry.deviceIds[0] || entry.clientId;
  const existing = [...$('deviceRows').children].find((row) => {
    const deviceId = row.querySelector('[data-field="id"]').value;
    const clientId = row.querySelector('[data-field="clientId"]').value || deviceId;
    return clientId === entry.clientId || deviceId === id;
  });
  if (existing) {
    existing.scrollIntoView({ block: 'center' });
    setText('devicesMessage', '이미 같은 기기 ID 또는 접속 Client ID 입력란이 있습니다. 기존 항목을 확인하세요.');
    return;
  }
  addDeviceRow({ id, clientId: entry.clientId });
  $('deviceRows').lastElementChild.scrollIntoView({ block: 'center' });
  setText('devicesMessage', '탐지 값을 입력했습니다. 실제 기기 ID를 확인하고 기기 목록 저장을 누르세요.');
});
