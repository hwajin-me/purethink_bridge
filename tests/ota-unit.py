"""Test the actual OTA program embedded in the single-file installer."""
import hashlib
import json
from pathlib import Path
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

installer = Path(__file__).resolve().parents[1] / 'install/purethink-bridge-install.sh'
code = installer.read_text().split('  cat > "$PB_WORK/server.py" <<\'PY\'\n', 1)[1].split('\nPY\n', 1)[0]
namespace = {'__name__': 'ota_test'}
exec(compile(code, 'embedded-ota', 'exec'), namespace)
server = ThreadingHTTPServer(('127.0.0.1', 0), namespace['Handler'])
server.firmware = b'fixture-binary'
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    for path in ['/version/combined', '/version/combined/', '/api/FirmwareVersionCombined', '/api/GetFirmwareVersionCombined']:
        for method in ['GET', 'POST', 'PUT']:
            with urllib.request.urlopen(urllib.request.Request(base + path, method=method)) as response:
                assert json.load(response)['LastVersionDiv'] == 'ver.220706.1633_DIV01'
    for path in ['/firmware/wrong.bin', '/firmware/ver.220706.1630_THESOOP.bin', '/firmware/../../etc/passwd']:
        try:
            urllib.request.urlopen(base + path)
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise AssertionError(path)
    with urllib.request.urlopen(base + namespace['FIRMWARE_PATH']) as response:
        assert response.read() == server.firmware
    with urllib.request.urlopen(urllib.request.Request(base + namespace['FIRMWARE_PATH'], method='HEAD')) as response:
        assert response.read() == b''
        assert int(response.headers['Content-Length']) == len(server.firmware)
    print('Embedded OTA routes and wrong-model rejection: PASS')
finally:
    server.shutdown()
    server.server_close()
    thread.join()
