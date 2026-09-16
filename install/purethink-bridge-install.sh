#!/usr/bin/env bash
# Ubuntu LXC installer: standalone or invoked with Community Scripts helpers.
# Source: https://github.com/hwajin-me/purethink_bridge
set -Ee -o pipefail
umask 022

pb_die() { printf '%s\n' "$*" >&2; exit 1; }
pb_log() { printf '\n==> %s\n' "$*"; }

pb_fetch() { curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "$@"; }

# Keep future pulls/pushes on the selected repository without changing the checkout.
pb_configure_origin() {
  local directory=$1 url=$2
  [[ -e $directory/.git ]] || return 0
  if git -C "$directory" remote get-url origin >/dev/null 2>&1; then
    git -C "$directory" remote set-url origin "$url"
  else
    git -C "$directory" remote add origin "$url"
  fi
  # An old explicit push URL would otherwise still point at the upstream repo.
  if git -C "$directory" config --get-all remote.origin.pushurl >/dev/null 2>&1; then
    git -C "$directory" config --unset-all remote.origin.pushurl
  fi
}

pb_usage() {
  cat <<'EOF'
Usage: bash purethink-bridge-install.sh
Run as root inside Ubuntu 24.04 LXC with systemd. Reruns are supported.
Default source: https://github.com/hwajin-me/purethink_bridge.git (main)
Optional: REPO_URL=<git URL> REPO_REF=<branch or tag> DIV01_FIRMWARE_URL=<original firmware URL>
No container IP input is required or saved by this installer.
Existing bridge source, runtime, environment, configuration and certificates are preserved.
Git origin is aligned with the selected REPO_URL (default: the fork); no automatic pull.
Installs bridge (33301/8885) and HTTP/HTTPS passthrough (80/443), origin HTTP proxy (6002) and loopback DIV01-only OTA server (16003). No device is flashed automatically.
EOF
}

pb_cleanup() {
  local status=$1
  trap - EXIT
  trap - ERR
  # Cleanup must not mask the original failure, even if a cleanup command fails.
  set +e
  # Keep installed files and all user state on failure; rerunning repairs services.
  [[ -z ${PB_WORK:-} ]] || rm -rf -- "$PB_WORK"
  [[ ${PB_LOCKED:-false} != true ]] || flock -u 9
  if ((status != 0)); then
    printf 'Installation failed. See the error above and journalctl -u purethink-bridge.\n' >&2
  fi
  # Preserve the framework's EXIT/telemetry handler rather than replacing it.
  if [[ -n ${PB_PREVIOUS_EXIT:-} ]]; then
    (eval "$PB_PREVIOUS_EXIT"; exit "$status")
  fi
  exit "$status"
}

pb_install_ota() {
  pb_log 'Preparing verified DIV01 firmware and OTA server'
  local original=ver.220706.1630_DIV01.bin
  local patched=ver.220706.1633_DIV01.bin
  if [[ -f $PB_FIRMWARE/$original ]]; then
    cp "$PB_FIRMWARE/$original" "$PB_WORK/$original"
  else
    if [[ -n ${DIV01_FIRMWARE_URL:-} ]]; then
      pb_fetch "$DIV01_FIRMWARE_URL" -o "$PB_WORK/$original"
    else
      local dns_server origin_ip downloaded=false
      for dns_server in 1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4; do
        while IFS= read -r origin_ip; do
          [[ $origin_ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
          if pb_fetch --noproxy '*' --resolve "dapt.iptime.org:6002:$origin_ip" \
            "http://dapt.iptime.org:6002/firmware/$original" -o "$PB_WORK/$original"; then
            downloaded=true
            break
          fi
        done < <(dig +short +time=2 +tries=1 "@$dns_server" dapt.iptime.org A)
        [[ $downloaded != true ]] || break
      done
      [[ $downloaded == true ]] || pb_die 'Unable to download original firmware using public DNS.'
    fi
  fi
  cat > "$PB_WORK/patch-div01.py" <<'PY'
import hashlib
import pathlib
import struct
import sys
if len(sys.argv) != 3:
    raise SystemExit('Usage: patch-div01.py ORIGINAL.bin PATCHED.bin')
source, destination = map(pathlib.Path, sys.argv[1:])
if source.resolve() == destination.resolve():
    raise SystemExit('Original and output paths must differ')
fw = bytearray(source.read_bytes())
if len(fw) != 509952 or hashlib.sha256(fw).hexdigest() != '454d85f3b4e56b51ac7776df154a37bf684b5bf81f3a81a19721de3e70b66d97':
    raise SystemExit('Unknown DIV01 original firmware: size/SHA256 mismatch; refusing to patch.')
base = 0x1000
magic, count, _, _, _ = struct.unpack_from('<BBBBI', fw, base)
if magic != 0xE9:
    raise SystemExit('Invalid ESP8266 image')
offset = 8
segments = []
for _ in range(count):
    load, size = struct.unpack_from('<II', fw, base + offset)
    offset += 8
    if base + offset + size > len(fw):
        raise SystemExit('Segment out of bounds')
    segments.append((load, size, base + offset))
    offset += size
matches = [start + 0x4020C82C - load for load, size, start in segments if load <= 0x4020C82C < load + size]
if len(matches) != 1 or fw[matches[0]:matches[0]+4] != bytes.fromhex('12 c1 90 c2'):
    raise SystemExit('DIV01 patch location mismatch')
fw[matches[0]:matches[0]+4] = bytes.fromhex('0c 02 0d f0')
if fw.count(b'ver.220706.1630_DIV01') != 2:
    raise SystemExit('DIV01 version string mismatch')
fw = fw.replace(b'ver.220706.1630_DIV01', b'ver.220706.1633_DIV01')
checksum = 0xEF
for _, size, start in segments:
    for byte in fw[start:start+size]:
        checksum ^= byte
fw[base + (((offset + 16) & ~15) - 1)] = checksum
if hashlib.sha256(fw).hexdigest() != '9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343':
    raise SystemExit('Patched DIV01 SHA256 mismatch; refusing to publish.')
destination.write_bytes(fw)
print('DIV01 original and patched SHA256: verified')
PY
  python3 "$PB_WORK/patch-div01.py" "$PB_WORK/$original" "$PB_WORK/$patched"
  mkdir -p "$PB_OTA" "$PB_FIRMWARE"
  chmod 0755 "$PB_OTA" /var/lib/purethink-ota "$PB_FIRMWARE"
  install -m 0644 "$PB_WORK/$original" "$PB_FIRMWARE/$original"
  install -m 0644 "$PB_WORK/$patched" "$PB_FIRMWARE/$patched"
  cat > "$PB_WORK/server.py" <<'PY'
#!/usr/bin/env python3
"""Read-only DIV01 OTA endpoint; never serves another model's image."""
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = 'ver.220706.1633_DIV01'
FIRMWARE_PATH = f'/firmware/{VERSION}.bin'
FIRMWARE = Path('/var/lib/purethink-ota/firmware') / f'{VERSION}.bin'
EXPECTED = '9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343'

class Handler(BaseHTTPRequestHandler):
    def respond(self, status, content, mime):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Connection', 'close')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(content)

    def handle_request(self):
        route = urlparse(self.path).path
        if route == FIRMWARE_PATH:
            return self.respond(200, self.server.firmware, 'application/octet-stream')
        lower = route.lower()
        if lower.startswith('/firmware/') or lower.endswith('.bin'):
            return self.respond(404, b'DIV01 firmware only\n', 'text/plain')
        if 'firmwareversioncombined' in lower or lower.rstrip('/').endswith('/version/combined'):
            payload = {'LastVersionDiv': VERSION, 'UpdateDate': '220706.1633',
                       'Hostname': 'dapt.iptime.org', 'Port': 6002,
                       'PathDiv': FIRMWARE_PATH, 'PathTestDiv': FIRMWARE_PATH}
            return self.respond(200, json.dumps(payload, separators=(',', ':')).encode(), 'application/json')
        return self.respond(404, b'Not found\n', 'text/plain')

    do_GET = handle_request
    do_HEAD = handle_request
    do_POST = handle_request
    do_PUT = handle_request

if __name__ == '__main__':
    image = FIRMWARE.read_bytes()
    if len(image) != 509952 or hashlib.sha256(image).hexdigest() != EXPECTED:
        raise SystemExit('Invalid DIV01 firmware: refusing to start OTA service')
    server = ThreadingHTTPServer(('127.0.0.1', 16003), Handler)
    server.firmware = image
    server.serve_forever()
PY
  install -m 0644 "$PB_WORK/server.py" "$PB_OTA/server.py"
  install -m 0644 "$PB_WORK/patch-div01.py" "$PB_OTA/patch-div01.py"
  cat > "$PB_WORK/purethink-manage" <<'CONTROL'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-help}" in
  status) systemctl status --no-pager purethink-bridge purethink-ota ;;
  restart) systemctl restart purethink-bridge purethink-ota ;;
  ota-start) systemctl enable --now purethink-ota ;;
  ota-stop) systemctl disable --now purethink-ota ;;
  logs) journalctl -u purethink-bridge -u purethink-ota -n 100 --no-pager ;;
  firmware-patch)
    [[ $# == 3 ]] || { echo 'Usage: purethink-manage firmware-patch ORIGINAL.bin PATCHED.bin' >&2; exit 1; }
    python3 /opt/purethink-ota/patch-div01.py "$2" "$3"
    ;;
  help|-h|--help)
    echo 'Usage: purethink-manage {status|restart|ota-start|ota-stop|logs|firmware-patch ORIGINAL.bin PATCHED.bin}' ;;
  *) echo 'Unknown command. Use purethink-manage help.' >&2; exit 1 ;;
esac
CONTROL
  install -m 0755 "$PB_WORK/purethink-manage" /usr/local/sbin/purethink-manage
  cat > /etc/systemd/system/purethink-ota.service <<'UNIT'
[Unit]
Description=Purethink DIV01 OTA Server
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=nobody
Group=nogroup
ExecStart=/usr/bin/python3 /opt/purethink-ota/server.py
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
}

pb_check_ota() {
  local attempt
  for ((attempt=0; attempt<30; attempt++)); do
    if systemctl is-active --quiet purethink-ota && python3 - <<'PY'
import hashlib
import json
import urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:16003/version/combined', timeout=2) as response:
        assert json.load(response)['LastVersionDiv'] == 'ver.220706.1633_DIV01'
    with urllib.request.urlopen('http://127.0.0.1:16003/firmware/ver.220706.1633_DIV01.bin', timeout=2) as response:
        assert hashlib.sha256(response.read()).hexdigest() == '9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343'
except Exception:
    raise SystemExit(1)
PY
    then return 0; fi
    sleep 2
  done
  journalctl -u purethink-ota -n 50 --no-pager
  pb_die 'OTA health check failed. Existing data has been preserved; fix the error and rerun.'
}

pb_main() {
  if [[ ${1:-} == --help || ${1:-} == -h ]]; then pb_usage; return 0; fi
  (($# == 0)) || pb_die 'Unexpected arguments. Use --help for usage.'
  [[ $EUID -eq 0 ]] || pb_die 'Run as root inside the Ubuntu LXC, not on the Proxmox host.'
  command -v pveversion >/dev/null && pb_die 'This is the Proxmox host. Run this script inside the Ubuntu LXC using pct exec.'
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || pb_die 'Ubuntu 24.04 LXC is required.'
  [[ $(systemd-detect-virt --container) == lxc ]] || pb_die 'Run inside an LXC container.'
  [[ -d /run/systemd/system ]] || pb_die 'systemd must be running.'

  # Serialize preflight and promotion so concurrent runs cannot delete each
  # other's staging/installation paths. flock is included in Ubuntu util-linux.
  command -v flock >/dev/null || pb_die 'Missing flock; install the Ubuntu util-linux package.'
  exec 9>/run/lock/purethink-bridge-install.lock
  flock -n 9 || pb_die 'Another Purethink Bridge installer is running.'
  PB_LOCKED=true
  PB_PREVIOUS_EXIT=$(trap -p EXIT)
  trap 'pb_cleanup "$?"' EXIT

  PB_APP=/opt/purethink-bridge
  PB_NODE=/opt/purethink-node
  PB_DATA=/var/lib/purethink-bridge
  PB_COMMUNITY=false
  local target arch archive version revision node_bin npm_bin npx_bin
  local repo_url=${REPO_URL:-https://github.com/hwajin-me/purethink_bridge.git}
  local repo_ref=${REPO_REF:-main}
  PB_OTA=/opt/purethink-ota
  PB_FIRMWARE=/var/lib/purethink-ota/firmware
  for target in "$PB_APP" "$PB_NODE" "$PB_DATA" "$PB_OTA" /var/lib/purethink-ota /etc/purethink-bridge.env; do
    [[ ! -L $target ]] || pb_die "Refusing unexpected symlink: $target"
  done
  if [[ -e $PB_APP ]]; then
    [[ -f $PB_APP/src/index.js && -f $PB_APP/package.json && -d $PB_APP/node_modules ]] || pb_die 'Incomplete bridge directory. Back it up and move it aside, then rerun.'
    [[ -f $PB_APP/src/origin-proxy.js && -f $PB_APP/src/firmware.js ]] || pb_die 'Update the existing Bridge source/dependencies first (README LXC update). Refusing to move legacy OTA away from 6002 without a replacement proxy.'
  fi
  if [[ -e $PB_NODE ]]; then
    [[ -x $PB_NODE/bin/node && $("$PB_NODE/bin/node" --version) == v22.* ]] || pb_die 'Existing Node runtime is incomplete or not version 22. Move it aside and rerun.'
  fi
  if getent passwd purethink-bridge >/dev/null; then
    [[ $(id -u purethink-bridge) != 0 && $(getent passwd purethink-bridge | cut -d: -f6) == "$PB_DATA" ]] || pb_die 'Unexpected existing purethink-bridge account.'
    getent group purethink-bridge >/dev/null || pb_die 'Missing purethink-bridge group.'
  fi
  case $(uname -m) in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) pb_die 'Supported architectures: x86_64, aarch64.' ;;
  esac

  export DEBIAN_FRONTEND=noninteractive
  if [[ -n ${FUNCTIONS_FILE_PATH:-} ]]; then
    PB_COMMUNITY=true
    # The framework passes shell source TEXT, not a filesystem path.
    # Do not enable nounset: shared helpers use optional, unset variables.
    # shellcheck disable=SC1091
    source /dev/stdin <<< "$FUNCTIONS_FILE_PATH"
    # Save the framework's handler before composing our cleanup with it.
    # Remove our own EXIT trap first if the framework did not replace it.
    if [[ $(trap -p EXIT) == *'pb_cleanup'* ]]; then trap - EXIT; fi
    color
    verb_ip6
    catch_errors
    PB_PREVIOUS_EXIT=$(trap -p EXIT)
    trap 'pb_cleanup "$?"' EXIT
    setting_up_container
    network_check
    update_os
  else
    trap 'printf "Installation failed at line %s.\n" "$LINENO" >&2' ERR
    apt-get update
  fi
  pb_log 'Installing dependencies'
  apt-get install -y --no-install-recommends ca-certificates curl git xz-utils build-essential python3 tzdata iproute2 util-linux passwd dnsutils
  # Existing managed services may already own these ports on a rerun.
  # Match the runtime defaults while respecting explicitly saved overrides.
  local web_ports
  web_ports=$(python3 - <<'PYPORTS'
import pathlib
import re
settings = {}
value = '80,443,17,18,1723,2522,6001,6003,8090,8883,8886,11222,11221,11622,11821,11822,12220,12933,14621,14821,20622,24833'
file = pathlib.Path('/etc/purethink-bridge.env')
if file.exists():
    for line in file.read_text().splitlines():
        match = re.match(r'^\s*(ORIGIN_TCP_PORTS|CUSTOM_BRIDGE_ENABLED|CUSTOM_HTTP_PORT|HTTPS_PORT|DASHBOARD_HTTPS_PORT)\s*=(.*)$', line)
        if match:
            settings[match[1]] = match[2].strip().strip(chr(34) + chr(39))
value = settings.get('ORIGIN_TCP_PORTS', value)
ports = [int(part.strip()) for part in value.split(',') if part.strip()]
if settings.get('CUSTOM_BRIDGE_ENABLED') == 'true':
    ports.extend([int(settings.get('CUSTOM_HTTP_PORT') or 80), int(settings.get('HTTPS_PORT') or 443)])
if settings.get('DASHBOARD_HTTPS_PORT'):
    ports.append(int(settings['DASHBOARD_HTTPS_PORT']))
if any(port < 1 or port > 65535 for port in ports):
    raise SystemExit('Invalid ORIGIN_TCP_PORTS')
print(' '.join(map(str, ports)))
PYPORTS
  )
  for target in 33301 8885 6002 16003 $web_ports; do
    local service=purethink-bridge
    [[ $target != 16003 ]] || service=purethink-ota
    if [[ -n $(ss -H -ltn "sport = :$target") ]]; then
      if [[ ! -f /etc/systemd/system/$service.service ]] || ! systemctl is-active --quiet "$service"; then
        # Pre-migration releases served OTA directly on 6002.
        if [[ ( $target == 6002 || $target == 6003 ) && -f /etc/systemd/system/purethink-ota.service ]] && systemctl is-active --quiet purethink-ota; then
          continue
        fi
        pb_die "TCP port $target is occupied by another service."
      fi
    fi
  done

  PB_WORK=$(mktemp -d /opt/.purethink-install.XXXXXX)
  # Staging is traversable so npm can run without root; its app subdir is writable.
  chmod 0755 "$PB_WORK"
  if [[ -d $PB_NODE ]]; then
    ln -s "$PB_NODE" "$PB_WORK/node"
  elif [[ $PB_COMMUNITY == true ]]; then
    mkdir "$PB_WORK/node"
    NODE_VERSION=22 setup_nodejs
    node_bin=$(command -v node)
    npm_bin=$(command -v npm)
    npx_bin=$(command -v npx)
    mkdir "$PB_WORK/node/bin"
    ln -s "$node_bin" "$PB_WORK/node/bin/node"
    ln -s "$npm_bin" "$PB_WORK/node/bin/npm"
    ln -s "$npx_bin" "$PB_WORK/node/bin/npx"
  else
    mkdir "$PB_WORK/node"
    pb_log 'Installing official Node.js 22 binary'
    pb_fetch https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$PB_WORK/SHASUMS256.txt"
    archive=$(awk -v arch="$arch" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$PB_WORK/SHASUMS256.txt")
    [[ -n $archive && $archive != *$'\n'* ]] || pb_die 'Unable to resolve a unique Node.js archive.'
    version=${archive#node-}
    version=${version%-linux-*}
    # Use the resolved immutable release URL: latest-v22.x can change mid-install.
    pb_fetch "https://nodejs.org/dist/$version/$archive" -o "$PB_WORK/$archive"
    (cd "$PB_WORK"; awk -v file="$archive" '$2 == file' SHASUMS256.txt | sha256sum --check -)
    tar -xJf "$PB_WORK/$archive" -C "$PB_WORK/node" --strip-components=1
  fi
  [[ $("$PB_WORK/node/bin/node" --version) == v22.* ]] || pb_die 'Node.js 22 is required.'

  if [[ ! -d $PB_APP ]]; then
  pb_log 'Downloading application'
  git clone --depth 1 --branch "$repo_ref" -- "$repo_url" "$PB_WORK/app"
  revision=$(git -C "$PB_WORK/app" rev-parse HEAD)
  [[ -f $PB_WORK/app/src/index.js && -f $PB_WORK/app/public/index.html ]] || pb_die 'Repository is missing application files.'
  # Use the existing unprivileged nobody account only while staging dependencies.
  # The persistent service account and data directory are created after npm succeeds.
  mkdir "$PB_WORK/npm-home"
  chown -R nobody:nogroup "$PB_WORK/app" "$PB_WORK/npm-home"
  (
    cd "$PB_WORK/app"
    local action=ci
    if [[ ! -f package-lock.json ]]; then
      printf 'Warning: source has no package-lock.json; dependency versions are not pinned.\n' >&2
      action=install
    fi
    runuser -u nobody -- env PATH="$PB_WORK/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME="$PB_WORK/npm-home" npm "$action" --omit=dev --no-audit --no-fund
  )
  chown -R root:root "$PB_WORK/app"
    mv "$PB_WORK/app" "$PB_APP"
  else
    pb_log 'Preserving existing bridge source and dependencies'
    revision=$(git -C "$PB_APP" rev-parse HEAD 2>/dev/null || printf unknown)
  fi
  pb_configure_origin "$PB_APP" "$repo_url"
  if [[ ! -d $PB_NODE ]]; then mv "$PB_WORK/node" "$PB_NODE"; fi

  pb_install_ota

  if [[ ! -e /etc/purethink-bridge.env ]]; then
  cat > /etc/purethink-bridge.env <<EOF
NODE_ENV=production
TZ=Asia/Seoul
DATA_DIR=$PB_DATA
HTTP_PORT=33301
DEVICE_MQTT_PORT=8885
DEVICE_MQTT_HOST=0.0.0.0
ORIGIN_HTTP_PORT=6002
ORIGIN_TCP_PORTS=80,443,17,18,1723,2522,6001,6003,8090,8883,8886,11222,11221,11622,11821,11822,12220,12933,14621,14821,20622,24833
CUSTOM_BRIDGE_ENABLED=false
# TLS_CERT_FILE=/var/lib/purethink-bridge/certs/fullchain.pem
# TLS_KEY_FILE=/var/lib/purethink-bridge/certs/server.key
# TLS_ROOT_CA_FILE=/var/lib/purethink-bridge/certs/root-ca.crt
# HTTPS_PORT=443
# DASHBOARD_HTTPS_PORT=33302
# PORT_SERVICES_FILE=/var/lib/purethink-bridge/services.json
LOCAL_OTA_ENABLED=false
LOCAL_OTA_PORT=16003
FIRMWARE_DIR=/var/lib/purethink-ota/firmware
EOF
  fi
  chmod 0600 /etc/purethink-bridge.env
  cat > /etc/systemd/system/purethink-bridge.service <<'EOF'
[Unit]
Description=Purethink MQTT Bridge
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=purethink-bridge
Group=purethink-bridge
WorkingDirectory=/opt/purethink-bridge
EnvironmentFile=/etc/purethink-bridge.env
ExecStart=/opt/purethink-node/bin/node /opt/purethink-bridge/src/index.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# Avoid filesystem namespace sandboxing (ProtectSystem/ProtectHome) in LXC.

[Install]
WantedBy=multi-user.target
EOF
  if ! id purethink-bridge >/dev/null 2>&1; then
    if getent group purethink-bridge >/dev/null; then
      useradd --system --gid purethink-bridge --home-dir "$PB_DATA" --shell /usr/sbin/nologin purethink-bridge
    else
      useradd --system --user-group --home-dir "$PB_DATA" --shell /usr/sbin/nologin purethink-bridge
    fi
  fi
  install -d -m 0700 -o purethink-bridge -g purethink-bridge "$PB_DATA"
  # Seed application defaults only once. Never overwrite saved credentials or
  # broker settings during a repeat installation; the app merges other defaults.
  if [[ ! -e $PB_DATA/config.json ]]; then
    cat > "$PB_WORK/config.json" <<'JSON'
{
  "internalMqtt": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 1883,
    "username": "",
    "password": "",
    "clientId": "purethink-bridge",
    "topic": "/things/#"
  }
}
JSON
    install -m 0600 -o purethink-bridge -g purethink-bridge "$PB_WORK/config.json" "$PB_DATA/config.json"
  fi
  # Preserve generated credentials/certificates and diagnostics after first activation.
  systemctl daemon-reload
  systemctl enable purethink-bridge purethink-ota
  systemctl stop purethink-ota
  systemctl restart purethink-bridge purethink-ota
  pb_log 'Checking HTTP API and MQTT TLS listener'
  local healthy=false attempt
  for ((attempt=0; attempt<30; attempt++)); do
    if systemctl is-active --quiet purethink-bridge && "$PB_NODE/bin/node" --input-type=module <<'JS'
import tls from 'node:tls';
import net from 'node:net';
try {
  const response = await fetch('http://127.0.0.1:33301/api/status', {signal: AbortSignal.timeout(2000)});
  const body = await response.json();
  if (!response.ok || !body.state?.bridge?.origin || !body.config?.internalMqtt) throw Error('Invalid bridge API response');
  for (const port of [6002, ...(body.state.bridge.origin.tcpPorts || [])]) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({host: '127.0.0.1', port}, () => {socket.end(); resolve();});
    socket.setTimeout(2000, () => {socket.destroy(); reject(Error(`Origin proxy port ${port} timeout`));});
    socket.on('error', reject);
  });
  }
  await new Promise((resolve, reject) => {
    const socket = tls.connect({host: '127.0.0.1', port: 8885, rejectUnauthorized: false}, () => {socket.end(); resolve();});
    socket.setTimeout(2000, () => {socket.destroy(); reject(Error('TLS timeout'));});
    socket.on('error', reject);
  });
} catch { process.exit(1); }
JS
    then
      healthy=true
      break
    fi
    sleep 2
  done
  if [[ $healthy != true ]]; then
    journalctl -u purethink-bridge -n 50 --no-pager
    pb_die 'Health check failed; installation retained for diagnosis. See README recovery.'
  fi
  pb_check_ota
  printf 'commit=%s\nnode=%s\n' "$revision" "$("$PB_NODE/bin/node" --version)" > "$PB_APP/INSTALL_VERSION"
  if [[ $PB_COMMUNITY == true ]]; then
    motd_ssh
    customize
    cleanup_lxc
  else
    apt-get clean
  fi
  printf '\nBridge: http://<LXC-IP>:33301\nOrigin proxy: http://<LXC-IP>:6002 (local DIV01 OTA: 127.0.0.1:16003)\nData: %s\nLocal MQTT auto-connects. Follow README UniFi DNS setup; enable local DIV01 OTA only when needed.\n' "$PB_DATA"
}

# Also supports the Community Scripts bash -c invocation and curl | bash.
if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  pb_main "$@"
fi
