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

  setText('summary', `Local control: ${state.device.localConnected && state.internal.status === 'connected' ? 'Available' : 'Check connections'}`);

  if (state.device.status === 'connected' && !state.device.localConnected) setText('summary', '기기 상태 수신 중 · 제조사 경유 (직접 연결 미확인)');

  setStatus('deviceStatus', state.device.status);
  $('deviceList').innerHTML = (state.devices || []).map((device) => `
    <div class="device-status">
      <b>${escapeText(device.name || device.id)}</b> · <span>${escapeText(device.status)}</span>
      <dl>
        <dt>기기 ID</dt><dd>${escapeText(device.id)}</dd>
        <dt>연결 경로</dt><dd>${device.connection === 'direct' ? 'Bridge 직접 연결' : device.connection === 'manufacturer' ? '제조사 경유 · 최근 90초 내 상태 수신' : '현재 연결·최근 상태 수신 없음'}</dd>
        <dt>등록 방식</dt><dd>${device.registered ? '직접 등록' : '자동 인식'}</dd>
        <dt>Last Seen</dt><dd class="time">${escapeText(device.lastSeen || '-')}</dd>
        <dt>Last Topic</dt><dd>${escapeText(device.lastTopic || '-')}</dd>
        <dt>RX / TX</dt><dd>${counts(device)}</dd>
      </dl>
    </div>`).join('') || '<p>등록하거나 연결된 기기가 없습니다.</p>';

  discoveredConnections = state.bridge.mqttDiscovery?.connections || [];
  // Preserve an in-progress candidate selection across status polling.
  const selections = new Map([...$('mqttDiscovery').querySelectorAll('select')].map((select) => [select.dataset.connection, select.value]));
  $('mqttDiscovery').innerHTML = discoveredConnections.slice().reverse().map((entry) => `
    <div class="mqtt-detection" data-connection="${entry.id}">
      <b>${entry.status === 'encrypted' ? 'TLS passthrough · MQTT/ID 확인 불가' : entry.status === 'unreadable' ? 'MQTT 분석 불가' : 'MQTT 토픽 관찰'}</b>
      <p>${escapeText(entry.remoteAddress || '-')}:${entry.remotePort || '-'} → :${entry.port} · ${escapeText(entry.mode)} · ${entry.active ? '연결 중' : '종료'}${entry.protocolVersion ? ` · MQTT ${entry.protocolVersion === 4 ? '3.1.1' : entry.protocolVersion === 3 ? '3.1' : '5'}` : ''}</p>
      <p>연결 시각: ${escapeText(entry.connectedAt)}${entry.captureError ? ` · ${escapeText(entry.captureError)}` : ''}</p>
      <p>기기 ID 후보: ${entry.deviceIds.map(escapeText).join(', ') || '아직 관찰되지 않음'}</p>
      ${entry.topics.map((item) => `<div><code>${escapeText(item.source)} ${escapeText(item.topic)}</code></div>`).join('')}
      ${entry.status === 'identified' && entry.deviceIds.length ? `<div class="device-actions">
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

  setStatus('localControl', state.device.localConnected && state.internal.status === 'connected' ? 'available' : 'limited');
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
  if (!entry?.deviceIds.length) return;
  const select = button.closest('.mqtt-detection').querySelector('select');
  if (select && !select.value) { select.focus(); return; }
  const id = select?.value || entry.deviceIds[0];
  const existing = [...$('deviceRows').children].find((row) => {
    const deviceId = row.querySelector('[data-field="id"]').value;
    return deviceId === id;
  });
  if (existing) {
    existing.scrollIntoView({ block: 'center' });
    setText('devicesMessage', '이미 같은 기기 ID 입력란이 있습니다. 기존 항목을 확인하세요.');
    return;
  }
  addDeviceRow({ id });
  $('deviceRows').lastElementChild.scrollIntoView({ block: 'center' });
  setText('devicesMessage', '탐지 값을 입력했습니다. 실제 기기 ID를 확인하고 기기 목록 저장을 누르세요.');
});

async function readBuildCa() {
  let rootCaPem = '';
  if ($('buildServerCa').checked) {
    const response = await fetch('/tls/root-ca.crt');
    if (!response.ok) throw Error('서버에 Root CA가 설정되어 있지 않습니다.');
    rootCaPem = await response.text();
  } else if ($('buildCaFile').files[0]) {
    if ($('buildCaFile').files[0].size > 16384) throw Error('Root CA 파일은 16 KiB 이하여야 합니다.');
    rootCaPem = await $('buildCaFile').files[0].text();
  }
  return rootCaPem;
}
$('validateBuildCa').addEventListener('click', async () => {
  $('validateBuildCa').disabled = true;
  setText('buildCaMessage', '검증 중…');
  try {
    const response = await fetch('/api/firmware/validate-root-ca', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootCaPem: await readBuildCa(), expectedRootCaFingerprint: $('buildCaFingerprint').value })
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'CA validation failed');
    const ca = result.rootCa;
    setText('buildCaMessage', `Root CA 구조·자체 서명·유효기간 검증 통과 · ${ca.subject} · 만료 ${ca.validTo} · SHA-256 ${ca.fingerprint256} · ${ca.fingerprintMatched ? '입력한 지문 일치' : '소유자 신뢰 미확인: 신뢰하는 경로의 지문과 대조하세요.'}`);
  } catch (error) { setText('buildCaMessage', error.message); }
  finally { $('validateBuildCa').disabled = false; }
});
for (const id of ['buildCaFile', 'buildServerCa', 'buildCaFingerprint']) {
  $(id).addEventListener('change', () => setText('buildCaMessage', 'CA 입력이 변경되었습니다. 다시 검증하세요.'));
}

const buildUrls = [];
$('buildServerCa').addEventListener('change', () => {
  $('buildCaFile').disabled = $('buildServerCa').checked;
});
$('firmwareBuildForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('buildFirmware').disabled = true;
  buildUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  $('buildDownloads').replaceChildren();
  setText('buildMessage', 'Building…');
  try {
    const rootCaPem = await readBuildCa();
    const response = await fetch('/api/firmware/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: $('buildVersion').value, tlsMode: 'bypass', rootCaPem, hostname: $('buildHostname').value, expectedRootCaFingerprint: $('buildCaFingerprint').value })
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Build failed');
    const download = (name, content, type) => {
      const url = URL.createObjectURL(new Blob([content], { type }));
      buildUrls.push(url);
      const link = document.createElement('a');
      link.href = url; link.download = name; link.textContent = name;
      $('buildDownloads').append(link);
    };
    download(result.filename, Uint8Array.from(atob(result.firmwareBase64), (c) => c.charCodeAt(0)), 'application/octet-stream');
    download(`${result.manifest.version}.manifest.json`, JSON.stringify(result.manifest, null, 2), 'application/json');
    if (result.rootCaPem) download(`${result.manifest.version}.root-ca.crt`, result.rootCaPem, 'application/x-x509-ca-cert');
    setText('buildMessage', `완료 · ${result.manifest.size} bytes · SHA-256 ${result.manifest.sha256} · CA 내장 없음 / TLS 검증 우회. 기기에 자동 적용되지 않습니다.`);
  } catch (error) { setText('buildMessage', error.message); }
  finally { $('buildFirmware').disabled = false; }
});
