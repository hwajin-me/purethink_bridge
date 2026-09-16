#!/usr/bin/env bash
# Run ONLY in a disposable Ubuntu Docker container. Real packages/app/firmware;
# LXC identity, systemd execution and Community Scripts helpers are test doubles.
set -Eeuo pipefail
[[ -f /.dockerenv && -d /source/install ]] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git systemd iproute2 curl >/dev/null
mkdir -p /run/systemd/system /tmp/fixture-bin
export PATH=/tmp/fixture-bin:$PATH
cat > /tmp/fixture-bin/systemd-detect-virt <<'MOCK'
#!/bin/bash
echo "${FIXTURE_VIRT:-lxc}"
MOCK
cat > /tmp/fixture-bin/systemctl <<'MOCK'
#!/bin/bash
set -e
operation=$1
shift
case "$operation" in
 daemon-reload|enable) exit 0 ;;
 is-active) [[ $1 != --quiet ]] || shift; kill -0 "$(cat "/tmp/$1.pid")" 2>/dev/null; exit ;;
 restart|start|stop)
  for service in "$@"; do
   if [[ -f /tmp/$service.pid ]]; then kill "$(cat "/tmp/$service.pid")" 2>/dev/null || true; sleep 1; fi
   [[ $operation != stop ]] || continue
   if [[ $service == purethink-bridge ]]; then
    set -a; source /etc/purethink-bridge.env; set +a
    cd /opt/purethink-bridge
    umask 0077
    runuser -u purethink-bridge -- /opt/purethink-node/bin/node src/index.js > /tmp/bridge.log 2>&1 &
   else
    runuser -u nobody -- python3 /opt/purethink-ota/server.py > /tmp/ota.log 2>&1 &
   fi
   echo $! > "/tmp/$service.pid"
  done ;;
 *) exit 1 ;;
esac
MOCK
cat > /tmp/fixture-bin/journalctl <<'MOCK'
#!/bin/bash
cat /tmp/bridge.log /tmp/ota.log
MOCK
chmod +x /tmp/fixture-bin/*
mkdir /tmp/repo
cp -r /source/install /source/src /source/public /source/package.json /source/package-lock.json /tmp/repo/
git -C /tmp/repo init -qb main
git -C /tmp/repo add .
git -C /tmp/repo -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
export REPO_URL=file:///tmp/repo
if [[ -f /fixtures/original.bin ]]; then export DIV01_FIRMWARE_URL=file:///fixtures/original.bin; fi
if FIXTURE_VIRT=kvm bash /source/install/purethink-bridge-install.sh; then exit 1; fi
bash /source/install/purethink-bridge-install.sh
systemd-analyze verify /etc/systemd/system/purethink-{bridge,ota}.service
purethink-manage help
bridge --help
# Refuse legacy code before changing service files or moving the OTA listener.
mv /opt/purethink-bridge/src/firmware.js /tmp/firmware.js.saved
if bash /source/install/purethink-bridge-install.sh > /tmp/legacy.log 2>&1; then exit 1; fi
grep -q 'Update the existing Bridge source' /tmp/legacy.log
mv /tmp/firmware.js.saved /opt/purethink-bridge/src/firmware.js
python3 - <<'FIRMWARE_TEST'
import hashlib, urllib.request
for version, expected in [
    ('ver.220706.1630_DIV01', '454d85f3b4e56b51ac7776df154a37bf684b5bf81f3a81a19721de3e70b66d97'),
    ('ver.220706.1633_DIV01', '9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343')]:
    url=f'http://127.0.0.1:6002/firmware/{version}.bin'
    with urllib.request.urlopen(url) as response:
        data=response.read()
        assert hashlib.sha256(data).hexdigest()==expected
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Range':'bytes=4096-4351'})) as response:
        assert response.status==206 and response.read()==data[4096:4352]
print('Bridge native original + patch firmware and Range: PASS')
FIRMWARE_TEST
purethink-manage firmware-patch /var/lib/purethink-ota/firmware/ver.220706.1630_DIV01.bin /tmp/repatched.bin
cmp /tmp/repatched.bin /var/lib/purethink-ota/firmware/ver.220706.1633_DIV01.bin
[[ $(stat -c %U /var/lib/purethink-bridge/config.json) == purethink-bridge ]]
[[ $(stat -c %a /var/lib/purethink-bridge) == 700 ]]
python3 - <<'PY'
import json
from pathlib import Path
config = json.loads(Path('/var/lib/purethink-bridge/config.json').read_text())
assert config['internalMqtt']['host'] == ''
assert config['internalMqtt']['port'] == 1883
assert config['internalMqtt']['enabled'] is False
PY
if grep -q DEVICE_MQTT_DISPLAY_HOST /etc/purethink-bridge.env; then exit 1; fi
curl -fsS -X POST -H 'Content-Type: application/json' -d '{"internalMqtt":{"enabled":false,"host":"custom.invalid","password":"test-secret","clientId":"persistent-test"}}' http://127.0.0.1:33301/api/config
sha256sum /var/lib/purethink-bridge/config.json /var/lib/purethink-bridge/certs/* /etc/purethink-bridge.env > /tmp/state.sha
# A repeat install must succeed and preserve source, environment and user state.
# Reinstallation must also replace stale fetch and explicit push destinations.
git -C /opt/purethink-bridge remote set-url origin https://example.invalid/old/bridge.git
git -C /opt/purethink-bridge remote set-url --push origin https://example.invalid/old/push.git
sha256sum /opt/purethink-bridge/src/index.js >> /tmp/state.sha
bash /source/install/purethink-bridge-install.sh
sha256sum -c /tmp/state.sha
[[ $(git -C /opt/purethink-bridge remote get-url origin) == "$REPO_URL" ]]
[[ $(git -C /opt/purethink-bridge remote get-url --push origin) == "$REPO_URL" ]]
# Update through the installed command, preserving settings and certificates.
echo updated > /tmp/repo/update-marker
git -C /tmp/repo add update-marker
git -C /tmp/repo -c user.name=Test -c user.email=test@example.invalid commit -qm update
bridge update
[[ -f /opt/purethink-bridge/update-marker ]]
sha256sum -c /tmp/state.sha
[[ $(git -C /opt/purethink-bridge rev-parse HEAD) == "$(git -C /tmp/repo rev-parse HEAD)" ]]
python3 - <<'PY'
import hashlib, json, urllib.request, urllib.error
base='http://127.0.0.1:16003'
for method in ['GET', 'POST', 'PUT']:
    with urllib.request.urlopen(urllib.request.Request(base+'/api/FirmwareVersionCombined', method=method)) as r:
        assert json.load(r)['LastVersionDiv']=='ver.220706.1633_DIV01'
url=base+'/firmware/ver.220706.1633_DIV01.bin'
with urllib.request.urlopen(url) as r:
    assert hashlib.sha256(r.read()).hexdigest()=='9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343'
with urllib.request.urlopen(urllib.request.Request(url, method='HEAD')) as r:
    assert int(r.headers['Content-Length'])==509952 and r.read()==b''
for path in ['/firmware/ver.220706.1630_THESOOP.bin','/firmware/../../etc/passwd','/firmware/other.bin']:
    try: urllib.request.urlopen(base+path)
    except urllib.error.HTTPError as error: assert error.code==404
    else: raise AssertionError(path)
print('OTA metadata, HEAD, exact image SHA256 and wrong-model rejection: PASS')
PY
# Invalid originals must be rejected, with current services/data left intact.
cp /var/lib/purethink-ota/firmware/ver.220706.1630_DIV01.bin /tmp/original.bin
printf bad > /var/lib/purethink-ota/firmware/ver.220706.1630_DIV01.bin
if bash /source/install/purethink-bridge-install.sh >/tmp/bad-firmware.log 2>&1; then exit 1; fi
grep -q 'SHA256 mismatch' /tmp/bad-firmware.log
sha256sum -c /tmp/state.sha
curl -fsS http://127.0.0.1:33301/api/status >/dev/null
cp /tmp/original.bin /var/lib/purethink-ota/firmware/ver.220706.1630_DIV01.bin
# Framework-style bash -c still supports a repeat install.
export FUNCTIONS_FILE_PATH='color() { :; }; verb_ip6() { :; }; catch_errors() { :; }; setting_up_container() { :; }; network_check() { :; }; update_os() { :; }; motd_ssh() { :; }; customize() { :; }; cleanup_lxc() { :; }'
bash -c "$(cat /source/install/purethink-bridge-install.sh)"
sha256sum -c /tmp/state.sha
systemctl stop purethink-bridge purethink-ota
printf 'Bridge + DIV01 patch + OTA + repeat installation + invalid firmware rejection: PASS\n'
