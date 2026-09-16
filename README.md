# Purethink Bridge

Purethink 환기장치를 로컬망에서 안정적으로 사용하기 위한 MQTT 브릿지 서버입니다.

제조사 MQTT 서버가 동작할 때는 기존 앱 사용성을 유지하고, 제조사 서버가 죽어도 Home Assistant와 내부 MQTT를 통해 로컬 제어가 가능하도록 만드는 구성을 목표로 합니다.

## 전체 구조

```text
Purethink 기기
  -> UniFi 내부 DNS: dapt.iptime.org = Bridge LAN IP
  -> Purethink Bridge (LXC 또는 Docker) :8885
       -> 공용 DNS로 조회한 원본 MQTT :8885
앱/기기 HTTP :6002 -> Bridge HTTP 프록시 -> 공용 DNS로 조회한 원본 HTTP :6002
       -> 내부 MQTT 서버 :1883
            -> Home Assistant purethink custom component
```

브릿지는 다음 역할을 합니다.

- 기기에서 들어오는 TLS MQTT 연결 수신
- 기기 상태를 제조사 MQTT로 전달
- 기기 상태를 내부 MQTT로 전달
- 제조사 MQTT에서 들어온 명령을 기기로 전달
- 내부 MQTT에서 들어온 명령을 기기로 전달
- 웹 대시보드에서 연결 상태와 payload stream 표시

## 주의사항

이 절차는 사용자가 소유한 기기를 로컬망에서 사용하기 위한 방법입니다.

- 펌웨어 수정과 OTA는 항상 위험이 있습니다.
- 잘못된 펌웨어를 올리면 기기가 부팅하지 않을 수 있습니다.
- 먼저 제조사 서버와 앱에서 기기가 정상 동작하는 상태를 확인한 뒤 진행하세요.

## 준비물

- Ubuntu 서버
- Docker 설치 방식을 선택할 경우 Docker
- Git
- Home Assistant
- 내부 MQTT 서버, 예: Mosquitto `1883`
- Purethink 기기의 IP 주소
- Purethink 기기의 device id, 예: `DIV01-ABCDEF`
- Purethink 기기 펌웨어 `ver.220706.1630_DIV01.bin`
- UniFi 또는 내부 DNS에서 Host (A) 레코드 설정 가능

이 문서의 예시는 다음 값을 사용합니다. 본인 환경에 맞게 바꿔서 사용하세요.

```text
Ubuntu 서버 IP: 192.168.0.4
기기 IP: 192.168.0.67
원본 IP: 1.1.1.1 → 1.0.0.1 → 8.8.8.8 → 8.8.4.4로 직접 조회 (고정 IP 없음)
브릿지 MQTT 포트: 8885
브릿지 대시보드 포트: 33301
내부 MQTT 포트: 1883
```

## 1. 펌웨어 다운로드

제조사 펌웨어는 다음 경로에서 확인되었습니다.

```text
http://dapt.iptime.org:6002/firmware/ver.220706.1630_DIV01.bin
```

다른 모델/라인업 펌웨어도 아래 경로에서 다운로드 가능한 경우가 있습니다.

```text
http://dapt.iptime.org:6002/firmware/ver.220706.1630_THESOOP.bin
http://dapt.iptime.org:6002/firmware/ver.211231.1400_DIV02.bin
http://dapt.iptime.org:6002/firmware/ver.220307.1130_AC01.bin
```

단, 이 문서의 패치 위치와 스크립트는 `ver.220706.1630_DIV01.bin`에서만 검증되었습니다. `THESOOP`, `DIV02`, `AC01` 펌웨어에는 그대로 적용하지 마세요. 해당 모델은 사용자가 직접 디스어셈블/분석해서 인증서 검증 루틴, 버전 문자열, checksum 위치를 확인한 뒤 별도 패치해야 합니다.

Ubuntu 서버나 작업 PC에서 다운로드합니다.

```bash
curl -L \
  -o ver.220706.1630_DIV01.bin \
  http://dapt.iptime.org:6002/firmware/ver.220706.1630_DIV01.bin
```

다운로드한 파일 크기를 확인합니다.

```bash
ls -l ver.220706.1630_DIV01.bin
```

예상 크기:

```text
509952 bytes
```

## 2. 펌웨어 수정

Purethink 기기는 제조사 MQTT에 TLS로 접속합니다. 로컬 브릿지 서버의 자체 인증서도 받아들이게 하려면 펌웨어의 인증서 fingerprint 검증 루틴을 우회해야 합니다.

확인된 펌웨어 기준:

```text
원본 파일: ver.220706.1630_DIV01.bin
수정 버전: ver.220706.1633_DIV01.bin
패치 위치: 0x0000c82c
원본 바이트: 12 c1 90 c2
수정 바이트: 0c 02 0d f0
버전 문자열: ver.220706.1630_DIV01 -> ver.220706.1633_DIV01
체크섬 위치: ESP8266 image checksum byte
```

아래 Python 스크립트는 위 패치를 적용하고 ESP8266 image checksum을 다시 계산합니다.

```bash
cat > patch_purethink_fw.py <<'PY'
import hashlib
import pathlib
import struct

src = pathlib.Path("ver.220706.1630_DIV01.bin")
out = pathlib.Path("ver.220706.1633_DIV01.bin")
fw = bytearray(src.read_bytes())

app_base = 0x1000
magic, segcnt, flash_mode, flash_size_freq, entry = struct.unpack_from("<BBBBI", fw, app_base)
if magic != 0xE9:
    raise SystemExit(f"Unexpected ESP image magic: {magic:#x}")

off = 8
segments = []
for i in range(segcnt):
    load, size = struct.unpack_from("<II", fw, app_base + off)
    off += 8
    data_fw_off = app_base + off
    off += size
    segments.append((load, size, data_fw_off))

def vma_to_fw(addr):
    for load, size, data_fw_off in segments:
        if load <= addr < load + size:
            return data_fw_off + (addr - load)
    raise ValueError(f"VMA not found: {addr:#x}")

patch_off = vma_to_fw(0x4020C82C)
expected = bytes.fromhex("12 c1 90 c2")
patched = bytes.fromhex("0c 02 0d f0")
if bytes(fw[patch_off:patch_off + 4]) != expected:
    raise SystemExit(f"Unexpected bytes at {patch_off:#x}: {fw[patch_off:patch_off + 4].hex(' ')}")
fw[patch_off:patch_off + 4] = patched

old_ver = b"ver.220706.1630_DIV01"
new_ver = b"ver.220706.1633_DIV01"
count = fw.count(old_ver)
if count != 2:
    raise SystemExit(f"Expected 2 version strings, found {count}")
fw[:] = fw.replace(old_ver, new_ver)

checksum_off = app_base + (((off + 16) & ~15) - 1)
chk = 0xEF
aoff = 8
for i in range(segcnt):
    load, size = struct.unpack_from("<II", fw, app_base + aoff)
    aoff += 8
    for b in fw[app_base + aoff:app_base + aoff + size]:
        chk ^= b
    aoff += size
fw[checksum_off] = chk

out.write_bytes(fw)
print("output:", out)
print("size:", len(fw))
print("sha256:", hashlib.sha256(fw).hexdigest())
print("checksum:", hex(chk), "at", hex(checksum_off))
PY

python3 patch_purethink_fw.py
```

검증된 `1633` 파일 정보:

```text
파일명: ver.220706.1633_DIV01.bin
크기: 509952 bytes
SHA256: 9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343
```

이미 검증된 `ver.220706.1633_DIV01.bin` 파일을 보관하고 있다면 패치 스크립트를 다시 실행하지 않아도 됩니다. 직접 해당 파일을 다운로드하거나 복사해서 OTA 서버의 `firmware/` 폴더에 넣으면 됩니다.

```bash
mkdir -p ~/purethink-ota/firmware
cp ver.220706.1633_DIV01.bin ~/purethink-ota/firmware/
```

본인이 배포 권한을 가진 범위에서 GitHub Release 또는 개인 저장소에 `ver.220706.1633_DIV01.bin`을 보관해 두었다면, 아래처럼 직접 내려받아 사용할 수도 있습니다.

```bash
mkdir -p ~/purethink-ota/firmware
curl -L \
  -o ~/purethink-ota/firmware/ver.220706.1633_DIV01.bin \
  '<ver.220706.1633_DIV01.bin 다운로드 URL>'
```

## 3. OTA 서버와 HTTP 대체

일반 실행에서는 Bridge의 `6002`가 제조사 HTTP API와 펌웨어 요청을 원본에 전달합니다. 메서드, 경로·쿼리, 요청 본문, 응답 상태·헤더·바이너리를 스트리밍하고 원본 Host를 유지합니다. 공용 DNS 실패 시 502를 반환하며 내부 DNS로 되돌아가지 않습니다.

Bridge가 시작되면 DIV01 원본을 공용 DNS 경로로 내려받아 크기와 SHA-256을 검증한 뒤 `1633` 패치를 준비합니다. MQTT 시작은 다운로드를 기다리지 않습니다. 다운로드 실패는 상태에 표시하고 60초 간격으로 재시도합니다. Docker/직접 실행은 `DATA_DIR/firmware`, LXC는 설치 스크립트의 `/var/lib/purethink-ota/firmware`를 사용합니다. `FIRMWARE_DIR`로 경로를 바꾸거나 `FIRMWARE_AUTO_PREPARE=false`로 자동 준비를 끌 수 있습니다. 기존 정상 파일은 재사용하며 손상된 파일은 제공하지 않습니다.

준비된 **DIV01 원본 `1630`과 패치 `1633` 파일은 OTA 광고 설정과 관계없이 6002에서 직접 다운로드**할 수 있습니다. 인터넷이 끊겨도 제공되며 GET/HEAD와 단일 HTTP Range 요청을 지원합니다. 다른 모델·파일은 원본으로 전달합니다. 패치 파일이 없을 때에는 503을 반환하고 준비되지 않은 패치 버전은 광고하지 않습니다.

`LOCAL_OTA_ENABLED=true`는 `/version/combined`, `/api/FirmwareVersionCombined`, `/api/GetFirmwareVersionCombined`에서 검증된 DIV01 패치 버전을 안내하도록 합니다. 기본값 false에서는 제조사 버전 응답을 그대로 전달합니다. **DIV01 업데이트 작업에만 활성화하고, 다른 모델이 함께 있는 환경에서는 활성화하지 마세요.** 다른 모델의 패치는 검증되지 않았습니다. LXC의 기존 Python OTA 서비스(127.0.0.1:16003)는 진단/호환용으로 유지되지만 Bridge의 파일 제공에는 필요하지 않습니다.

대시보드에서 Firmware 상태와 준비된 파일을 확인하고 `Prepare / Retry DIV01 Firmware`로 재시도할 수 있습니다. 기기 플래시는 자동으로 수행하지 않습니다. 수동 준비와 다운로드 예시:

```bash
npm run firmware:prepare
# 인터넷 없이 이미 가진 정식 원본으로 준비 (동일한 해시 검증 적용)
npm run firmware:prepare -- /path/to/ver.220706.1630_DIV01.bin
# Docker 안에서도 동일하게 실행 가능
docker exec purethink_bridge npm run firmware:prepare
curl -fO http://<Bridge-IP>:6002/firmware/ver.220706.1633_DIV01.bin
curl -I http://<Bridge-IP>:6002/firmware/ver.220706.1630_DIV01.bin
```

## 4. UniFi 내부 DNS 설정

Bridge에 고정 LAN IP를 할당하고 UniFi의 DNS 레코드에 다음 값을 등록합니다.

| 항목 | 값 |
| --- | --- |
| Type | Host (A) |
| Domain | `dapt.iptime.org` |
| IP Address | Bridge의 LAN IPv4 (예: `192.168.0.4`) |
| TTL | 전환 중에는 짧게, 예: 60초 |

Network 9.4는 `Settings > Policy Table > Create New Policy > DNS`, 9.3은 `Settings > Policy Engine > DNS`에서 생성합니다. 클라이언트가 UniFi 게이트웨이를 DNS로 사용해야 적용됩니다. [Ubiquiti 공식 DNS 설정 문서](https://help.ui.com/hc/en-us/articles/15179064940439-UniFi-DNS-Records-and-Local-Hostnames)를 참고하세요.

기기와 앱의 DHCP DNS도 해당 내부 DNS로 맞추고 연결을 재시작하여 이전 DNS 캐시·MQTT 연결을 갱신합니다. 클라이언트가 외부 DNS/DoH, IPv6 AAAA 또는 IP 하드코딩으로 우회하면 A 레코드만으로 전환되지 않습니다. `A`와 `AAAA` 응답 및 기기 연결을 확인하세요. 기본 Bridge 리스너는 IPv4입니다.

Bridge에서 공용 DNS 네 곳으로 UDP/TCP 53이 직접 통과하도록 허용하세요. UniFi의 DNS 강제 리다이렉트·콘텐츠 필터가 이 트래픽을 내부 DNS로 가로채지 않도록 Bridge를 예외 처리해야 합니다. 원본 조회는 사설·루프백·자기 주소 응답을 거부합니다.

```bash
nslookup dapt.iptime.org <UniFi-DNS-IP>
nslookup dapt.iptime.org 1.1.1.1
curl -fsS http://<Bridge-IP>:33301/api/status
```

첫 번째는 Bridge IP, 두 번째는 원본 공인 IP가 나와야 합니다. 대시보드의 Origin IP/Public DNS에서도 원본 조회 상태를 확인할 수 있습니다. Bridge 자체는 DNS 서버가 아니므로 DHCP DNS를 Bridge IP로 지정하지 마세요.

## 5. DNS 전환 원복

UniFi에서 추가한 `dapt.iptime.org` 레코드를 삭제하고 기기·앱의 DNS 캐시와 연결을 갱신하면 원본으로 돌아갑니다. Bridge가 공유기 설정을 자동 변경하지는 않습니다.

## 6. 브릿지 서버 설치

### Proxmox LXC / Ubuntu 24.04 설치

[`install/purethink-bridge-install.sh`](install/purethink-bridge-install.sh)는 **이미 생성한 Ubuntu LXC 내부에서 root로 실행하는 재실행 가능한 설치 스크립트**입니다. [Community Scripts 설치 문서](https://community-scripts.org/docs/install/readme)의 컨테이너 내부 설치 흐름을 참고한 독립 실행형이며, `FUNCTIONS_FILE_PATH`가 전달되면 공용 초기화·Node.js 설치·정리 함수를 사용하고, 없으면 독립 실행합니다. 이 파일은 컨테이너 내부용 `install/` 스크립트이며, Proxmox 호스트에서 LXC를 생성하는 `ct/` 스크립트나 Community Scripts 공식 등록 항목은 아닙니다.

Node.js 22와 systemd로 실행하며 Docker는 필요하지 않습니다. Ubuntu의 systemd 서비스가 정상 동작하도록 Unprivileged LXC의 Nesting 옵션은 활성화하세요. 앱 서비스 자체에는 추가 mount namespace를 요구하는 `ProtectSystem`/`ProtectHome`을 사용하지 않습니다. 소스, 런타임, 데이터를 각각 `/opt/purethink-bridge`, `/opt/purethink-node`, `/var/lib/purethink-bridge`에 설치합니다. 재실행하면 기존 브릿지 소스·Node.js·환경 파일·설정·인증서를 보존하고 서비스와 OTA 구성만 다시 설치합니다. Git `origin`의 fetch/push 대상은 선택한 `REPO_URL`(기본: `hwajin-me/purethink_bridge`)로 맞춥니다. 자동 pull은 하지 않으며 브릿지 소스 업데이트는 아래 별도 절차를 사용합니다. 동시에 두 설치가 실행되지 않도록 잠금을 사용합니다. `bash purethink-bridge-install.sh --help`로 사용법을 확인할 수 있습니다.

1. Proxmox 웹 UI에서 Ubuntu **24.04** LXC 템플릿을 내려받고 `Create CT`로 컨테이너를 생성합니다.
2. 시작값으로 Unprivileged 컨테이너(Nesting 활성화), CPU 2코어, RAM 1024MB, 디스크 8GB를 사용합니다. 브릿지는 기기 LAN에 연결된 브릿지(예: `vmbr0`)로 지정합니다.
3. 컨테이너에 고정 IPv4, 게이트웨이, DNS를 설정하고 시작합니다. GitHub, nodejs.org, npm registry와 Ubuntu 패키지 저장소에 접근할 수 있어야 합니다.
4. 방화벽을 사용 중이면 기기에서 LXC의 TCP `8885` 및 앱에서 TCP `80`/`443`, 관리 PC에서 TCP `33301`, OTA에 사용하는 기기와 앱에서 TCP `6002` 접근을 허용합니다. 원본 TCP `80`/`443`/`8885`/`6002`, 내부 MQTT 포트와 지정 공용 DNS 네 곳의 UDP/TCP `53`으로 나가는 연결도 필요합니다. 대시보드에는 인증 기능이 없으므로 신뢰하는 LAN에서만 접근하도록 제한하세요.

이 저장소를 받은 **Proxmox 호스트**에서 스크립트를 복사하고 실행합니다. 아래 `120`은 실제 CT ID로 바꾸세요. 설치 스크립트에는 컨테이너 IP를 입력하지 않습니다.

```bash
# 저장소 루트에서 실행
pct push 120 install/purethink-bridge-install.sh /root/purethink-bridge-install.sh
pct exec 120 -- bash /root/purethink-bridge-install.sh
```

또는 스크립트 파일을 LXC로 복사한 뒤 LXC 콘솔에서 직접 실행합니다. 설치 스크립트는 IP를 선택하거나 환경 파일에 저장하지 않습니다. DHCP를 사용한다면 공유기에서 주소 예약을 설정하세요.

```bash
bash /root/purethink-bridge-install.sh
```

LXC 내부 root 셸에서 포크의 설치 스크립트를 직접 내려받아 실행할 수도 있습니다. 아래 경로를 사용하려면 변경한 설치 스크립트와 앱 소스가 포크의 `main`에 커밋·push되어 있어야 합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/hwajin-me/purethink_bridge/main/install/purethink-bridge-install.sh \
  -o /root/purethink-bridge-install.sh
bash /root/purethink-bridge-install.sh
```

기본 설치 소스는 사용자 포크 `https://github.com/hwajin-me/purethink_bridge.git`의 `main`입니다. 포크나 특정 브랜치/태그를 설치하려면 `REPO_URL`, `REPO_REF`를 함께 지정할 수 있습니다.

새 설치의 기본 내부 MQTT는 실행 환경의 로컬 브로커 `127.0.0.1:1883`이며 연결이 활성화됩니다. 다른 서버의 브로커를 사용하면 대시보드에서 Host를 지정하세요. 인증이 필요하면 `http://<LXC IP>:33301`에서 ID/PW를 입력하세요. 재설치 시 기존 MQTT 설정·인증정보는 보존하며, MQTT 브로커 자체를 LXC에 설치하지는 않습니다. DIV01 펌웨어 패치와 OTA 서버는 자동으로 준비됩니다. UniFi DNS 전환, 기기의 실제 펌웨어 업데이트, Home Assistant 설정은 이 문서의 해당 절차를 따릅니다. 이후 예제의 Ubuntu 서버 IP에는 LXC IP를 사용합니다.

#### 자동 설치되는 DIV01 OTA

- 브릿지: `purethink-bridge.service`, 대시보드 `33301`, MQTT/TLS `8885`, 원본 HTTP 프록시 `6002`
- OTA: `purethink-ota.service`, loopback HTTP `16003`, 재부팅 시 자동 시작
- OTA 코드: `/opt/purethink-ota/server.py`
- 별도 패치 스크립트: `/opt/purethink-ota/patch-div01.py`
- 관리 명령: `/usr/local/sbin/purethink-manage`
- 원본·패치 펌웨어: `/var/lib/purethink-ota/firmware/`

최초 설치 시 제조사 `ver.220706.1630_DIV01.bin`을 다운로드하여 `1633`으로 패치합니다. 크기(509952 bytes), 원본 SHA-256(`454d85f3b4e56b51ac7776df154a37bf684b5bf81f3a81a19721de3e70b66d97`), 패치 결과 SHA-256(`9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343`)을 모두 확인합니다. 다른 파일이면 배포하지 않습니다. 재실행 시에는 저장된 원본을 검증하여 재사용합니다.

제조사 다운로드가 불가능하면 동일한 원본을 제공하는 URL 또는 LXC 내부 파일 URL을 지정할 수 있습니다. 해시 검사는 그대로 적용됩니다.

```bash
DIV01_FIRMWARE_URL=file:///root/ver.220706.1630_DIV01.bin bash /root/purethink-bridge-install.sh
```

설치 완료 후 수동 펌웨어 패치 단계는 생략할 수 있습니다. 위 DNS 설정과 `LOCAL_OTA_ENABLED` 절차에 따라 **DIV01만** 업데이트하세요. 진단용 OTA 백엔드는 다른 모델·파일에 404를 반환하고, Bridge는 검증된 DIV01 두 파일을 로컬에서 제공하며 나머지 요청은 원본으로 전달합니다. 기기에 자동 플래시하지 않습니다.

```bash
curl -fsS http://127.0.0.1:16003/version/combined
curl -I http://127.0.0.1:16003/firmware/ver.220706.1633_DIV01.bin
journalctl -u purethink-ota -n 50 --no-pager
# OTA 작업 후 서버도 중지하려면:
systemctl disable --now purethink-ota
```

설치 후 관리 스크립트로 각 작업을 별도로 실행할 수 있습니다.

```bash
purethink-manage status
purethink-manage restart
purethink-manage ota-stop
purethink-manage ota-start
purethink-manage logs
purethink-manage firmware-patch /root/ver.220706.1630_DIV01.bin /root/ver.220706.1633_DIV01.bin
```

`firmware-patch`는 지정한 파일을 검증·패치하여 출력할 뿐, 기기에 전송하거나 플래시하지 않습니다.

설치 스크립트를 재실행하면 OTA 서비스도 다시 활성화됩니다. 앱 소스와 LXC IP는 설치 스크립트가 수정하지 않습니다.

LXC 내부 관리 명령:

```bash
systemctl status purethink-bridge
journalctl -u purethink-bridge -n 50 --no-pager
systemctl restart purethink-bridge
curl -fsS http://127.0.0.1:33301/api/status
```

실행 환경은 `/etc/purethink-bridge.env`에서 변경하고 서비스를 재시작합니다. IP 변경 시 UniFi의 DNS A 레코드를 갱신해야 합니다. 설정·인증서는 `/var/lib/purethink-bridge`에 보관되므로 이 경로와 환경 파일을 백업하세요. 다운로드·npm 설치 단계는 임시 디렉터리에서 진행하고 실패 시 정리하므로 재실행할 수 있습니다. 서비스 활성화 이후 실패하면 설정과 인증서를 보존하고 아래 복구 절차를 따릅니다. 설치 완료 표시는 API 응답과 TLS 연결 확인 후에만 기록됩니다.

#### 설치 실패 복구

`journalctl -u purethink-bridge -n 100 --no-pager`와 설치 오류를 확인하세요. 오류를 해결한 뒤 같은 설치 스크립트를 다시 실행할 수 있습니다. 이미 설치된 소스·환경 파일·설정·인증서는 유지합니다. `226/NAMESPACE`가 발생하면 기존 서비스의 `ProtectSystem`/`ProtectHome` 설정을 제거하고 `systemctl daemon-reload`를 실행하세요. Ubuntu 기본 서비스도 실패한다면 Proxmox의 Nesting 옵션을 확인합니다.

기존 설치가 불완전해 새로 설치해야 한다면 Proxmox 백업을 만든 뒤 새 LXC에 설치하고 `/var/lib/purethink-bridge`와 `/etc/purethink-bridge.env`를 복원합니다. 복원 중에는 서비스를 중지하고 데이터 소유자를 `purethink-bridge:purethink-bridge`, 디렉터리 권한을 `0700`으로 맞추세요. 기존 데이터 경로를 자동 삭제하지 않습니다.

대시보드는 `http://<LXC IPv4>:33301`로 접속하세요. 표시 주소를 지정하려면 `DEVICE_MQTT_DISPLAY_HOST`를 설정할 수 있으며 실제 리스닝 주소와는 별개입니다.

#### LXC 설치의 업데이트

기존 원본 저장소 설치도 아래 절차에서 `origin`을 사용자 포크로 전환합니다. 로컬 변경이나 분기된 이력 때문에 fast-forward가 불가능하면 중단되며 강제로 덮어쓰지 않습니다.

업데이트 전에 Proxmox에서 컨테이너 백업 또는 스냅샷을 만드세요. LXC 내부 root 셸에서 실행합니다. 설치 스크립트를 재실행해도 기존 브릿지 소스는 자동 업데이트하지 않습니다.

```bash
bash <<'UPDATE'
set -Eeuo pipefail
systemctl stop purethink-bridge purethink-ota
cd /opt/purethink-bridge
# 이전 설치에서 npm이 생성한 미추적 lockfile은 새 tracked lockfile과 충돌합니다.
if [[ -f package-lock.json ]] && ! git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
  mv package-lock.json "/root/purethink-package-lock.$(date +%s).json"
fi
git remote set-url origin https://github.com/hwajin-me/purethink_bridge.git
git pull --ff-only
export PATH=/opt/purethink-node/bin:$PATH
# 저장소에 lockfile이 없으면 이전 설치에서 생성된 파일도 갱신합니다.
if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
  action=ci
else
  action=install
fi
chown -R purethink-bridge:purethink-bridge /opt/purethink-bridge
trap 'chown -R root:root /opt/purethink-bridge' EXIT
runuser -u purethink-bridge -- env PATH="$PATH" HOME=/var/lib/purethink-bridge npm "$action" --omit=dev --no-audit --no-fund
chown -R root:root /opt/purethink-bridge
printf 'commit=%s\nnode=%s\n' "$(git rev-parse HEAD)" "$(node --version)" > INSTALL_VERSION
bash install/purethink-bridge-install.sh
UPDATE

journalctl -u purethink-bridge -n 50 --no-pager
curl -fsS http://127.0.0.1:33301/api/status
```

실패하면 서비스를 중지한 상태에서 원인을 해결하거나 컨테이너 백업으로 복구하세요. 태그로 설치해 detached HEAD 상태라면 `git pull` 대신 업데이트할 태그를 명시적으로 fetch/checkout해야 합니다. 위 절차는 앱과 서비스 구성을 갱신하여 기존 6002 OTA를 loopback 16003으로 이전합니다. Node.js는 변경하지 않습니다. 독립 설치의 Node.js는 `/opt/purethink-node`에 있으므로 OS 패키지 업데이트로 갱신되지 않습니다. Community Scripts 모드는 `setup_nodejs`로 설치한 시스템 런타임에 연결됩니다. 런타임 업데이트는 별도로 관리하세요.

#### 설치 스크립트 검증

DNS failover·TTL·순환 방지, HTTP/TCP 프록시, 실제 MQTT 브로커를 이용한 자동 연결·재연결·다중 기기 구독 테스트는 `npm ci && npm test`로 실행합니다. 패치 OTA 라우트는 `python3 tests/ota-unit.py`로 검증합니다.

전체 설치는 다음 명령으로 폐기 가능한 Ubuntu 컨테이너에서 검증할 수 있습니다.

```bash
docker run --rm -v "$PWD:/source:ro" ubuntu:24.04 bash /source/tests/install-smoke.sh
```

실제 브릿지 설치 및 API/TLS, DIV01 원본과 패치 결과 해시, OTA의 GET/POST/PUT/HEAD 응답, 다른 모델·잘못된 경로의 거부, 반복 설치 시 설정·인증서 보존, 잘못된 펌웨어 거부를 확인합니다. 테스트에서는 LXC 판별, systemd 실행 및 Community Scripts 공용 함수를 대체하므로, 실제 Proxmox의 부팅·AppArmor·네트워크 및 공용 함수 전체 동작은 별도의 LXC 검증이 필요합니다.

### Ubuntu Docker 설치

Ubuntu 서버에서 저장소를 받습니다.

```bash
sudo mkdir -p /opt/purethink-bridge
sudo chown -R $USER:$USER /opt/purethink-bridge

git clone https://github.com/hwajin-me/purethink_bridge.git /opt/purethink-bridge
cd /opt/purethink-bridge
```

이미 clone되어 있다면 pull 합니다.

```bash
cd /opt/purethink-bridge
git remote set-url origin https://github.com/hwajin-me/purethink_bridge.git
git pull --ff-only
```

Docker 이미지를 빌드합니다.

```bash
docker build -t purethink_bridge:latest .
```

컨테이너를 실행합니다.

```bash
mkdir -p /opt/purethink-bridge/data

docker rm -f purethink_bridge 2>/dev/null || true

docker run -d \
  --name purethink_bridge \
  --restart unless-stopped \
  --network host \
  -e TZ=Asia/Seoul \
  -e DEVICE_MQTT_DISPLAY_HOST=192.168.0.4 \
  -v /opt/purethink-bridge/data:/data \
  purethink_bridge:latest
```

`--network host`를 사용하면 컨테이너가 우분투 서버의 네트워크를 그대로 사용합니다.
따라서 `-p 8885:8885`, `-p 33301:33301` 포트 매핑은 넣지 않습니다.
우분투 서버에서 `80`, `443`, `8885`, `6002`, `33301` 포트를 이미 다른 서비스가 사용 중이면 컨테이너 실행이 실패할 수 있습니다.

상태 확인:

```bash
docker ps --filter name=purethink_bridge
docker logs --tail 50 purethink_bridge
```

대시보드:

```text
http://<Ubuntu 서버 IP>:33301
```

예:

```text
http://192.168.0.4:33301
```

## 7. Docker pull 방식(현재는 사용 불가)

현재 이 저장소는 소스에서 직접 Docker build하는 방식을 기본으로 합니다.

만약 Docker Hub 또는 GHCR에 이미지를 배포했다면 아래처럼 pull/run 방식으로 사용할 수 있습니다.

```bash
docker pull ghcr.io/hwajin-me/purethink_bridge:latest

docker rm -f purethink_bridge 2>/dev/null || true

docker run -d \
  --name purethink_bridge \
  --restart unless-stopped \
  --network host \
  -e TZ=Asia/Seoul \
  -e DEVICE_MQTT_DISPLAY_HOST=192.168.0.4 \
  -v /opt/purethink-bridge/data:/data \
  ghcr.io/hwajin-me/purethink_bridge:latest
```

## 8. 내부 MQTT 설정

대시보드에서 내부 MQTT 정보를 입력합니다.

```text
Enabled: 체크
Host: 내부 MQTT 서버 IP
Port: 1883
Username: 내부 MQTT ID
Password: 내부 MQTT PW
Client ID: purethink-bridge
Subscribe Topic: /things/#
```

저장 후 대시보드 상태가 아래처럼 보여야 합니다.

```text
Manufacturer MQTT: connected
Internal MQTT: connected
Device: offline
```

아직 내부 DNS 전환 전이면 `Device: offline`이 정상입니다.

## 9. 원본 DNS와 추가 서비스

원본 MQTT/HTTP와 추가 TCP 프록시는 모두 같은 전용 resolver를 사용합니다. 공용 DNS를 순서대로 시도하고 TTL(최대 300초) 동안 캐시합니다. 동시 조회는 하나로 합치고 IP가 여러 개면 새 연결마다 순환합니다. 조회 실패 시 OS DNS 또는 만료된 IP를 사용하지 않으며 다음 연결 시 재시도합니다. MQTT는 5초마다 자동 재연결하고 연결된 모든 기기 토픽을 다시 구독합니다.

주요 대체 포트는 `80`(HTTP), `443`(HTTPS), `8885`(MQTT/TLS), `6002`(펌웨어/API)입니다. `80`과 `443`은 원본의 같은 포트로 TCP를 그대로 전달합니다. HTTPS의 인증서·SNI·ALPN(HTTP/2 포함)은 원본과 iOS 앱 사이에 유지되며 기본 bypass 모드에서는 MQTT용 자체 서명 인증서를 HTTPS에 사용하지 않습니다. 추가 TCP 포트 목록과 custom 모드 설정은 아래 절을 참조하세요.

`ORIGIN_TCP_PORTS`를 지정하면 기본 목록을 대체합니다. 추가 HTTPS 포트가 필요한 예시는 `ORIGIN_TCP_PORTS=80,443,8443`입니다. 명시적으로 빈 값이면 TCP 전달을 비활성화합니다.

#### 기존 설치에서 iOS HTTPS 연결 복구

80/443 bypass는 별도 환경 변수 없이 기본 활성화됩니다. 기존 환경 파일에 `ORIGIN_TCP_PORTS` 항목이 없어도 적용됩니다. 소스 업데이트 후 설치 스크립트를 재실행하면 LXC 서비스의 `CAP_NET_BIND_SERVICE` 권한과 포트 검사를 함께 적용합니다. 과거에 `ORIGIN_TCP_PORTS`를 빈 값이나 다른 포트 목록으로 명시했다면 해당 줄을 삭제해 기본값을 사용하거나 `80,443`을 포함하도록 수정하세요.

```bash
systemctl daemon-reload
systemctl restart purethink-bridge
ss -ltnp | grep -E ':80 |:443 |:6002 |:8885 '
curl -fsS http://127.0.0.1:33301/api/status
```

UniFi/VPN 방화벽에서 iPhone → Bridge TCP 443/80, Bridge → 원본 TCP 443/80 연결을 허용하세요. Docker `--network host`에서는 호스트 포트를 사용하며, bridge 네트워크에서는 `-p 80:80 -p 443:443`도 게시해야 합니다. 기존 웹 서버가 해당 포트를 점유하면 해결 후 시작하세요. IPv6 AAAA를 사용하는 iPhone은 IPv4 A 레코드만 바꿔도 다른 경로로 접속할 수 있으므로 실제 DNS 응답을 확인하세요.

대시보드 `HTTPS :443`와 `/api/status`의 `state.bridge.origin.tcpServices`에 리스닝 상태, 접속 횟수와 원본 연결 오류를 표시합니다. 접속 횟수가 늘지 않으면 DNS·VPN·방화벽 경로를, 횟수가 늘면서 원본 시간 초과가 보이면 원본 포트와 아웃바운드 경로를 확인합니다. TCP 원본 연결은 10초 내 연결되지 않으면 종료하며 원본 인증서 오류를 우회하지 않습니다. 이 환경에서 원본 443 연결 자체가 안 된다면 전달만으로 정상 HTTPS를 만들 수는 없습니다. 앱이 비표준 HTTPS 포트를 사용하는 경우 그 포트를 `ORIGIN_TCP_PORTS`에 포함하세요.

UDP나 목록에 없는 포트는 전달하지 않습니다.

이 구성은 원본 서비스의 LAN 진입점을 대체합니다. 제조사 HTTP API를 로컬에서 재구현한 것은 아니므로 원본 장애 시 HTTP·제조사 앱 기능은 실패할 수 있습니다. 기기–내부 MQTT–Home Assistant의 로컬 제어는 원본과 독립적으로 유지됩니다. MQTT의 제조사 토픽은 `/things/` 범위를 지원하며 기존 펌웨어의 인증서 검증 패치는 여전히 필요합니다.

## 10. 기존 설정 이전과 자동 MQTT 연결

새 설치와 Docker/직접 실행 모두 `127.0.0.1:1883` 자동 연결이 기본입니다. Docker/직접 실행에서 다른 기본 서버를 쓰려면 첫 실행 전에 `INTERNAL_MQTT_HOST`를 설정하세요. LXC 설치 후에는 대시보드에서 서버를 변경하세요. `INTERNAL_MQTT_ENABLED=false`로 첫 실행 자동 연결을 끌 수 있습니다. 이미 저장한 host/port/ID/PW 및 비활성화 선택은 보존합니다. 잘못된 포트·토픽·타입은 저장 전에 거부하고, 설정은 권한 0600의 임시 파일을 원자적으로 교체해 보관합니다. 빈 비밀번호 입력은 기존 값을 유지하며 `Clear saved password`로 명시적으로 삭제할 수 있습니다. 예전 버전의 host가 비어 있는 초기 설정만 자동 연결 기본값으로 이전합니다. 별도 MQTT 브로커를 자동 설치하지는 않습니다. `127.0.0.1`은 Bridge가 실행되는 호스트 또는 컨테이너 자신을 가리킵니다. Docker bridge 네트워크에서 별도 브로커를 사용하면 해당 브로커의 서비스명이나 접근 가능한 IP를 지정하세요.

ASUS 공유기 SSH/DNAT UI·API·의존성은 제거되었습니다. 남아 있는 `routerDnat` 설정과 공유기 비밀번호는 앱 시작 시 설정 파일에서 제거합니다. 장비의 기존 네트워크 규칙은 앱이 변경하지 않습니다. 이전 서버에서 6002를 OTA가 점유하고 있다면 **소스 업데이트 후 설치 스크립트를 다시 실행**하여 16003으로 이전한 뒤 DNS를 전환하세요.

## 11. Home Assistant 설정

Home Assistant 연동은 Bridge와 별도 프로젝트인 custom component `af950833/purethink`에서 내부 MQTT 서버를 선택하도록 수정된 버전을 사용합니다. 이 참조는 Bridge의 설치·업데이트 저장소가 아닙니다.

새 통합 추가 시:

```text
MQTT 연결 방식: Local MQTT
Host: 내부 MQTT 서버 IP
Port: 1883
Username: 내부 MQTT ID
Password: 내부 MQTT PW
Device ID: DIV01-xxxx
```

브릿지는 내부 MQTT에 기존 제조사 토픽과 같은 형태로 publish합니다.

```text
/things/DIV01-xxxxxx/shadow
```

따라서 Home Assistant 컴포넌트는 제조사 MQTT 대신 내부 MQTT만 바라보면 됩니다.

## 12. 동작 확인 명령

브릿지 컨테이너 로그:

```bash
docker logs -f purethink_bridge
```

대시보드 API:

```bash
curl -s http://127.0.0.1:33301/api/status
```

내부 MQTT 확인:

```bash
mosquitto_sub -h '<MQTT_HOST>' -p 1883 \
  -u '<MQTT_ID>' -P '<MQTT_PW>' \
  -t '/things/#' -v
```

브릿지 포트 확인:

```bash
ss -ltnp | grep -E ':8885|:6002|:33301'
```

DNS 전환 확인:

```bash
nslookup dapt.iptime.org <UniFi-DNS-IP>
curl -I http://dapt.iptime.org:6002/firmware/ver.220706.1630_DIV01.bin
```

## 13. 업데이트 방법

아래는 Docker 설치용입니다. LXC 설치는 위의 [LXC 설치의 업데이트](#lxc-설치의-업데이트)를 따르세요.

소스 업데이트:

```bash
cd /opt/purethink-bridge
git remote set-url origin https://github.com/hwajin-me/purethink_bridge.git
git pull --ff-only
docker build -t purethink_bridge:latest .
docker rm -f purethink_bridge
docker run -d \
  --name purethink_bridge \
  --restart unless-stopped \
  --network host \
  -e TZ=Asia/Seoul \
  -e DEVICE_MQTT_DISPLAY_HOST=192.168.0.4 \
  -v /opt/purethink-bridge/data:/data \
  purethink_bridge:latest
```

## 14. 문제 해결

### Device가 offline

- 기기에서 사용하는 DNS의 dapt.iptime.org 응답이 Bridge IP인지 확인
- 기기와 Bridge 사이 TCP 8885 방화벽 및 DNS 캐시 확인
- 기기 IP가 맞는지 확인
- 기기가 펌웨어 `1633`인지 확인
- 브릿지 컨테이너가 `8885`를 listen 중인지 확인

```bash
ss -ltnp | grep 8885
```

### Internal MQTT가 reconnecting

- 내부 MQTT host/port 확인
- ID/PW 확인
- Mosquitto ACL 또는 password file 확인

### Manufacturer MQTT가 offline

- 제조사 서버 장애일 수 있습니다.
- 이 경우에도 `Device <-> Bridge <-> Internal MQTT <-> Home Assistant` 경로는 유지되어야 합니다.

### 앱 제어는 안 되지만 HA 제어는 됨

- 제조사 MQTT가 장애일 수 있습니다.
- 이 프로젝트의 목적은 이런 상황에서 로컬 제어를 유지하는 것입니다.

### payload stream에 다른 기기 메시지가 많이 보임

브릿지는 기기가 접속한 후 해당 기기 토픽만 제조사 MQTT에서 구독합니다.

```text
/things/<connected-client-id>/#
```

컨테이너 재시작 직후 기기가 아직 붙지 않은 상태에서는 제조사 MQTT 구독이 제한적으로 동작합니다. 기기가 연결되면 해당 기기 토픽으로 좁혀집니다.


### 회귀 검증 범위

`npm test`는 DNS, HTTP/TCP 프록시, 펌웨어 검증·패치·오프라인 다운로드·Range, 동일 MQTT 메시지의 에코 억제, 원본 연결 중단 중 기기 이탈, 로컬 MQTT 재연결, 잘못된 설정의 거부를 확인합니다. `tests/install-smoke.sh`는 실제 DIV01 원본 및 결과 해시, 구버전 설치 보호, 서비스·설정 보존을 확인합니다. 합성 펌웨어를 쓰는 단위 테스트와 실제 원본 SHA-256 검증은 별개로 수행합니다.

MQTT 3에서는 수신 메시지에 발행자 ID가 없으므로 에코는 토픽·본문·개수·5초 만료 시간으로 추적합니다. 다른 클라이언트가 같은 토픽·본문을 그 시간에 발행하는 경우까지 완벽히 구별할 수는 없습니다. 원본 HTTP API·다른 모델의 OTA를 로컬에서 재구현한 것은 아닙니다.

### 사용자 인증서와 Root CA, custom Bridge on/off

`CUSTOM_BRIDGE_ENABLED=false`가 기본입니다. 기본 모드에서는 80/443을 원본에 TCP 전달하므로 원본 인증서가 사용됩니다. `true`로 변경하면 Bridge가 80의 HTTP와 443의 HTTPS를 직접 처리합니다. 검증된 펌웨어 파일은 로컬에서 제공하고, 나머지 경로는 공개 DNS로 조회한 원본의 HTTP 6002로 전달합니다. 원본의 모든 HTTPS API를 오프라인으로 재구현한 것은 아닙니다. 관리 화면/API는 별도 관리 포트에만 있습니다.

LXC의 `/etc/purethink-bridge.env`에 다음을 설정합니다. Docker 또는 직접 실행에서도 같은 환경변수를 사용합니다.

```dotenv
CUSTOM_BRIDGE_ENABLED=true
TLS_CERT_FILE=/var/lib/purethink-bridge/certs/fullchain.pem
TLS_KEY_FILE=/var/lib/purethink-bridge/certs/server.key
TLS_ROOT_CA_FILE=/var/lib/purethink-bridge/certs/root-ca.crt
HTTPS_PORT=443
# 선택: 관리 화면도 동일한 인증서로 HTTPS 제공
DASHBOARD_HTTPS_PORT=33302
# 선택: 기존 DIV01 장치에 로컬 패치 버전 광고
LOCAL_OTA_ENABLED=true
```

- `fullchain.pem`: `dapt.iptime.org` SAN이 있는 PEM 서버 인증서, 이어서 중간 CA 인증서들을 발급 순서로 넣습니다. Root CA가 직접 서명했다면 서버 인증서만 넣습니다.
- `server.key`: 서버 인증서와 일치하는 암호화되지 않은 PEM 개인키. Root CA 개인키는 Bridge에 복사하지 않습니다.
- `root-ca.crt`: 선택적인 공개 Root CA 인증서. 설정하면 서버 인증서 체인이 이 Root CA로 연결되는지 시작 시 검증합니다. 인증서/키 오류, 만료, 호스트명 불일치가 있으면 시작을 중단합니다.
- 인증서 경로를 설정하면 MQTT TLS 8885에도 동일한 인증서를 적용합니다. custom 모드를 꺼도 명시한 MQTT 인증서와 선택적 관리 HTTPS 설정은 유지됩니다.
- `CUSTOM_HTTP_PORT`(기본 80), `HTTPS_PORT`(기본 443)를 바꾸면 해당 포트에서 직접 처리합니다. `ORIGIN_TCP_PORTS`의 동일 포트는 중복 바인딩하지 않습니다.

인증서 파일은 `purethink-bridge` 사용자가 읽을 수 있어야 합니다. 개인키 권한은 `0600`, 소유자는 `purethink-bridge`로 설정하고 상위 디렉터리 접근 권한도 확인합니다. 설정/인증서 변경 후 `systemctl restart purethink-bridge`로 적용합니다. 설치 스크립트를 다시 실행해도 기존 환경 파일과 인증서를 보존합니다. Docker에서는 인증서 디렉터리를 읽기 전용 마운트하고 사용할 80/443/33302/8885 포트를 게시합니다.

HTTPS 펌웨어 다운로드 예: `https://dapt.iptime.org/firmware/ver.220706.1633_DIV01.bin`. 기존 파일 경로의 GET/HEAD/Range 처리를 그대로 지원합니다. Root CA 공개 인증서는 관리 포트의 `/tls/root-ca.crt`에서 내려받을 수 있습니다. `/api/status`에서 모드와 서버 인증서 지문/만료일을 확인할 수 있습니다.

클라이언트가 사용자 Root CA를 신뢰하도록 별도로 설정해야 합니다. 서버의 Root CA 설정 자체가 iOS/장치의 신뢰 저장소를 변경하지 않으며, 앱이 인증서를 고정(pin)했다면 사용자 CA 인증서도 거부할 수 있습니다. 기존 DIV01 패치는 인증서 검증 우회 패치이며, Root CA 내장 또는 HTTPS OTA 기능 추가 패치가 아닙니다. 따라서 기존 OTA 메타데이터는 HTTP 6002를 유지합니다. HTTPS 다운로드는 해당 CA를 신뢰하고 HTTPS를 지원하는 클라이언트에서 사용할 수 있습니다.

대체 모드를 끄려면 `CUSTOM_BRIDGE_ENABLED=false`로 변경하고 서비스를 재시작합니다. 로컬 패치 버전 광고까지 끄려면 `LOCAL_OTA_ENABLED=false`도 설정합니다. 기본값은 둘 다 `false`입니다.

### 추가 서비스 포트 및 접근 기록

기본 TCP 전달 포트는 `80,443,17,18,1723,2522,6001,6003,8090,8883,8886,11222,11221,11622,11821,11822,12220,12933,14621,14821,20622,24833`입니다. 기존 설치에서 `ORIGIN_TCP_PORTS=80,443`을 저장했다면 그 줄을 삭제하거나 위 목록으로 바꾸고 재시작해야 추가 포트가 활성화됩니다. Docker에서는 필요한 포트를 별도로 게시하고 UniFi 방화벽에서도 허용해야 합니다.

6003은 이제 원본 전달용입니다. 기존 loopback Python OTA 서비스는 **16003**으로 이전하므로 LXC에서는 업데이트한 설치 스크립트를 재실행하세요. 런타임 코드만 바꾸면 이전 OTA 서비스의 6003과 충돌할 수 있습니다.

custom 모드에서도 별도 지정이 없는 추가 포트는 원본 서버의 동일 포트로 전달합니다. 해당 프로토콜을 처리하는 로컬 서비스가 있다면 다음 JSON으로 목적지를 지정합니다. 이 매핑은 `CUSTOM_BRIDGE_ENABLED=true`일 때만 적용됩니다.

```dotenv
CUSTOM_TCP_ROUTES='{"8883":{"host":"127.0.0.1","port":1884},"6003":{"host":"127.0.0.1","port":16003}}'
```

이는 TCP 바이트 전달입니다. 예시의 8883 클라이언트가 TLS를 사용하면 목적지 1884도 TLS를 처리해야 하므로 실제 로컬 서비스의 TLS 포트로 바꾸세요. 포트 번호만으로 프로토콜을 추정하거나 TLS를 제거하지 않습니다. 설정 대상은 활성화된 TCP 전달 포트여야 하며, IPv4 주소와 포트를 지정합니다. custom 모드를 끄면 모든 매핑이 무시되어 원본으로 전달됩니다. 각 서버의 기능을 자동으로 재구현하지 않습니다. UDP 및 TCP 외 프로토콜은 아직 지원하지 않습니다.

대시보드 **Port Access**와 `/api/status`의 `state.bridge.access`에서 포트별 누적 접속 수, 현재 연결 수, 최근 기록을 확인합니다. 디스크 기록은 `DATA_DIR/logs/access.jsonl`에 남으며 5 MiB마다 `.1`로 한 번 회전합니다. 최근 메모리 기록은 500건이고 카운터는 재시작 시 초기화됩니다. 연결/종료 시각, 접속 IP·포트, 수신 포트, 송수신 바이트, 원본 연결 오류를 기록하며 통신 내용은 기록하지 않습니다. 관리 화면 접근도 포함됩니다.

### 포트별 TLS 프록시 / Node.js 서버 시뮬레이션

`PORT_SERVICES_FILE`로 포트별 서비스 구현을 선택할 수 있습니다. **`CUSTOM_BRIDGE_ENABLED=false`가 기본이며 OFF 상태에서는 이 파일과 모듈을 로드하지 않습니다.** ON 상태에서 파일에 없는 포트는 기존 동작을 유지합니다. 기존 `CUSTOM_TCP_ROUTES`보다 이 파일의 설정을 우선 적용합니다.

적용 가능한 포트는 `ORIGIN_TCP_PORTS`에 활성화된 모든 포트와 Bridge의 HTTP/HTTPS·MQTT·펌웨어 포트입니다. 기본 구성에서는 요청된 추가 20개와 80, 443, 8885, 6002를 포함한 24개 포트입니다. 관리 화면 포트는 대체하지 않습니다.

```dotenv
CUSTOM_BRIDGE_ENABLED=true
TLS_CERT_FILE=/var/lib/purethink-bridge/certs/fullchain.pem
TLS_KEY_FILE=/var/lib/purethink-bridge/certs/server.key
TLS_ROOT_CA_FILE=/var/lib/purethink-bridge/certs/root-ca.crt
PORT_SERVICES_FILE=/var/lib/purethink-bridge/services.json
```

`services.json` 예:

```json
{
  "8883": {
    "mode": "proxy",
    "transport": "tls",
    "upstream": {
      "host": "dapt.iptime.org",
      "port": 8883,
      "transport": "tls",
      "servername": "dapt.iptime.org"
    }
  },
  "6001": {
    "mode": "proxy",
    "transport": "tls",
    "upstream": { "host": "dapt.iptime.org", "port": 6001, "transport": "tcp" }
  },
  "20622": {
    "mode": "simulate",
    "transport": "tls",
    "protocol": "stream",
    "module": "/opt/purethink-bridge/src/services/ports/20622.js",
    "options": { "maxKeys": 1000 }
  }
}
```

- `proxy`: Bridge가 클라이언트 TLS를 사용자 인증서로 종료하고, 복호화한 바이트를 목적지의 TCP 또는 별도 TLS 연결로 전달합니다. 요청 내용을 HTTP로 가정하지 않아 바이너리 프로토콜에도 사용할 수 있습니다. 클라이언트가 평문이면 `transport: "tcp"`를 선택합니다. 원본의 실제 TCP/TLS 여부는 포트 번호로 추정하지 말고 확인 후 지정하세요.
- 원본 `dapt.iptime.org`는 기존 공용 DNS resolver를 사용합니다. 다른 목적지는 IPv4로 지정합니다. 원본 TLS 인증서는 기본 검증하며, 사설 CA는 `upstream.caFile`로 지정합니다. 클라이언트에 제시하는 인증서와 원본의 신뢰 CA는 별개입니다. 명시적인 `rejectUnauthorized: false`는 원본 인증서 검증을 끄므로 검증 가능한 CA 설정을 우선 사용하세요.
- `simulate`: 원본 연결 없이 Node.js 모듈에서 실제 요청을 처리합니다. `protocol: "stream"`은 TCP/TLS 소켓, `protocol: "http"`는 HTTP/HTTPS 요청·응답 객체를 받습니다. `transport: "tls"`는 두 경우 모두 사용자 서버 인증서를 사용합니다.
- 파일 경로(`module`, `upstream.caFile`)는 JSON 파일 위치를 기준으로 해석합니다. 서비스 사용자에게 읽기 권한이 있어야 합니다. 모듈은 서버 권한으로 실행되는 신뢰된 코드이며 업로드 API는 제공하지 않습니다. 설정/소스 변경은 서비스 재시작 후 적용됩니다.

각 포트의 독립 구현 파일은 `src/services/ports/<포트>.js`에 있습니다. `createHandler({ port, config, log })`를 export하고 소켓 또는 HTTP 요청 처리 함수를 반환하면 됩니다. factory는 async도 지원하며 포트당 한 번 호출되어 상태를 유지할 수 있습니다.

```js
export function createHandler({ port, config, log }) {
  return (socket) => {
    socket.on('data', (bytes) => {
      // 실제 프로토콜에 맞는 프레이밍·명령 처리·응답을 여기 구현합니다.
      socket.write(bytes); // 최소 echo 예제
    });
    socket.on('end', () => socket.end());
  };
}
```

전체 포트를 TLS 시뮬레이터로 실행하는 개발용 설정은 `src/services/all-ports.example.json`입니다. LXC에서 `PORT_SERVICES_FILE=/opt/purethink-bridge/src/services/all-ports.example.json`으로 지정할 수 있습니다. 예제는 80을 포함해 모든 포트에 TLS를 사용하므로 평문 클라이언트와는 통신하지 않습니다. 8885/6002까지 이 설정으로 대체하면 기존 MQTT 브리지/펌웨어 핸들러도 교체됩니다. 운영 시 필요한 포트만 JSON에 넣으세요.

현재 제공하는 시뮬레이터는 다음과 같습니다.

- HTTP 예제: `GET /health`, `GET /info`, HEAD 지원. 그 외 경로는 404, 다른 메서드는 405.
- 스트림 예제: 줄바꿈으로 구분한 JSON의 `ping`, `set`, `get`, `delete`. 키 값은 포트별 메모리에 저장되며 재시작 시 초기화됩니다. 부분 수신/여러 명령 동시 수신, 요청 크기·키 개수·유휴 시간 제한을 처리합니다.

예: `{"op":"set","key":"power","value":true}` 뒤 줄바꿈, 이어서 `{"op":"get","key":"power"}` 뒤 줄바꿈을 보내면 저장된 값을 반환합니다. 이들 예제는 원본 제조사 프로토콜의 구현이 아닙니다. 포트별 실제 명령/인증/응답 형식이 확인되면 해당 포트 파일에 구현해야 원본과 호환됩니다. TCP/TLS 범위만 지원하며 UDP·GRE는 포함하지 않습니다. 모든 모드는 기존 접근 로그에 포트·접속 IP·시각·송수신량을 남기고 TLS/서비스 오류도 기록합니다.
