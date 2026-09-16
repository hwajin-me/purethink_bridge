import test from 'node:test';
import { createMqttDiscovery } from '../src/mqtt-discovery.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import selfsigned from 'selfsigned';
import { once } from 'node:events';
import { createOriginLookup, DNS_SERVERS, ORIGIN_HOST } from '../src/origin.js';
import { createOriginProxy, createTcpProxy, originTcpPorts } from '../src/origin-proxy.js';

const query = (lookup, options = {}) => new Promise((resolve, reject) => lookup(ORIGIN_HOST, options,
  (error, address, family) => error ? reject(error) : resolve({ address, family })));

test('public resolvers fail over in order, coalesce, cache until TTL, and rotate IPs', async () => {
  let clock = 1000;
  const attempts = [];
  const updates = [];
  const resolver = createOriginLookup({ now: () => clock, onUpdate: (update) => updates.push(update),
    resolverFactory: () => ({ setServers(servers) { this.server = servers[0]; },
      async resolve4(host, options) {
        assert.equal(host, ORIGIN_HOST); assert.deepEqual(options, { ttl: true });
        attempts.push(this.server);
        if (this.server !== DNS_SERVERS[3]) throw new Error('DNS unavailable');
        return [{ address: '203.0.113.1', ttl: 2 }, { address: '203.0.113.2', ttl: 4 }];
      } }) });
  const [one, two] = await Promise.all([query(resolver.lookup), query(resolver.lookup)]);
  assert.equal(one.address, '203.0.113.1'); assert.equal(two.address, '203.0.113.2');
  assert.deepEqual(attempts, DNS_SERVERS);
  assert.equal((await query(resolver.lookup, { all: true })).address.length, 2);
  assert.equal(attempts.length, 4);
  clock += 2001;
  await query(resolver.lookup);
  assert.equal(attempts.length, 8);
  assert.equal(updates.at(-1).server, '8.8.4.4');
});

test('rejects self resolution and expired cache; never falls back to system DNS', async () => {
  let fails = false; let clock = 0;
  const resolver = createOriginLookup({ now: () => clock, resolverFactory: () => ({ setServers() {},
    async resolve4() { return [{ address: fails ? '127.0.0.1' : '203.0.113.5', ttl: 1 }]; } }) });
  await query(resolver.lookup);
  fails = true; clock = 1001;
  await assert.rejects(query(resolver.lookup), { code: 'EAI_AGAIN' });
  await assert.rejects(new Promise((resolve, reject) => resolver.lookup('evil.example', {}, (error) => error ? reject(error) : resolve())));
});

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
function request(port, { path = '/api/test?q=one', method = 'POST', body = Buffer.from([0, 255, 10]), headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end(body);
  });
}
const loopbackLookup = (host, options, callback) => {
  assert.equal(host, ORIGIN_HOST);
  if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};

test('HTTP streams method/path/binary body, Host, status, cookies, HEAD and Range', async (t) => {
  const origin = http.createServer(async (req, res) => {
    assert.equal(req.headers.host, `${ORIGIN_HOST}:${origin.address().port}`);
    assert.equal(req.headers['x-hop'], undefined);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.method !== 'HEAD') assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 255, 10]));
    assert.equal(req.url, '/api/test?q=one');
    assert.equal(req.headers.range, 'bytes=0-2');
    res.writeHead(206, { 'Content-Length': 3, 'Content-Range': 'bytes 0-2/10', 'Set-Cookie': ['a=1', 'b=2'] });
    res.end(Buffer.from([1, 255, 2]));
  });
  const originPort = await listen(origin);
  const proxy = createOriginProxy({ lookup: loopbackLookup, originPort });
  const port = await listen(proxy);
  t.after(() => { proxy.close(); origin.close(); });
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
    const result = await request(port, { method, body: method === 'HEAD' ? Buffer.alloc(0) : Buffer.from([0, 255, 10]),
      headers: { host: 'untrusted.example', range: 'bytes=0-2', connection: 'x-hop', 'x-hop': 'strip', 'content-length': method === 'HEAD' ? '0' : '3' } });
    assert.equal(result.status, 206); assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
    assert.deepEqual(result.body, method === 'HEAD' ? Buffer.alloc(0) : Buffer.from([1, 255, 2]));
  }
  assert.equal((await request(port, { path: 'http://evil.example/' })).status, 400);
});

test('origin outage returns 502 and missing firmware cannot advertise a patch', async (t) => {
  const lookup = (_host, _options, callback) => callback(new Error('DNS down'));
  const proxy = createOriginProxy({ lookup, localOta: true });
  const port = await listen(proxy); t.after(() => proxy.close());
  assert.equal((await request(port, { path: '/api/FirmwareVersionCombined' })).status, 503);
  assert.equal((await request(port, { path: '/firmware/other-model.bin' })).status, 502);
  assert.equal((await request(port)).status, 502);
  const normal = createOriginProxy({ lookup }); const normalPort = await listen(normal);
  t.after(() => normal.close());
  assert.equal((await request(normalPort, { path: '/api/FirmwareVersionCombined' })).status, 502);
});

test('additional TCP origin service preserves bytes bidirectionally', async (t) => {
  const origin = net.createServer((socket) => socket.pipe(socket));
  const originPort = await listen(origin);
  const proxy = createTcpProxy({ port: originPort, lookup: loopbackLookup });
  const port = await listen(proxy);
  t.after(() => { proxy.close(); origin.close(); });
  const client = net.connect(port, '127.0.0.1');
  const data = once(client, 'data'); client.write(Buffer.from([0, 255, 1]));
  assert.deepEqual((await data)[0], Buffer.from([0, 255, 1])); client.destroy();
});


test('TCP proxy drains a large response after client half-close', async (t) => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 0xab);
  const origin = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.resume(); socket.on('end', () => socket.end(payload));
  });
  const originPort = await listen(origin);
  const proxy = createTcpProxy({ port: originPort, lookup: loopbackLookup });
  const port = await listen(proxy);
  t.after(() => { proxy.close(); origin.close(); });
  const client = net.connect(port, '127.0.0.1');
  const chunks = []; client.on('data', (chunk) => chunks.push(chunk));
  client.end('request'); await once(client, 'end');
  assert.deepEqual(Buffer.concat(chunks), payload);
});


test('standard HTTP/HTTPS are enabled by default; explicit overrides remain supported', () => {
  assert.deepEqual(originTcpPorts(), [80,443,17,18,1723,2522,6001,6003,8090,8883,8886,11222,11221,11622,11821,11822,12220,12933,14621,14821,20622,24833]);
  assert.deepEqual(originTcpPorts(''), []);
  assert.deepEqual(originTcpPorts('80,443,8443,443'), [80, 443, 8443]);
  assert.throws(() => originTcpPorts('443', [443]), /conflicting/);
  assert.throws(() => originTcpPorts('not-a-port'), /Invalid/);
});

test('HTTPS passthrough preserves certificate validation, SNI, ALPN and response', async (t) => {
  const pem = selfsigned.generate([{ name: 'commonName', value: ORIGIN_HOST }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: ORIGIN_HOST }] }]
  });
  let receivedSni; let connections = 0; let connected = false;
  const discovery = createMqttDiscovery();
  const origin = tls.createServer({ key: pem.private, cert: pem.cert, ALPNProtocols: ['h2', 'http/1.1'] }, (socket) => {
    receivedSni = socket.servername;
    socket.end('origin TLS response');
  });
  const originPort = await listen(origin);
  const proxy = createTcpProxy({ port: originPort, lookup: loopbackLookup,
    onConnection: (socket) => { connections++; discovery.observe(socket, {port:443,mode:'passthrough'}); }, onConnect: () => { connected = true; } });
  const port = await listen(proxy);
  t.after(() => { proxy.close(); origin.close(); });
  const client = tls.connect({ host: '127.0.0.1', port, servername: ORIGIN_HOST,
    ca: pem.cert, rejectUnauthorized: true, ALPNProtocols: ['h2', 'http/1.1'] });
  const chunks = []; client.on('data', (chunk) => chunks.push(chunk));
  await once(client, 'secureConnect');
  assert.equal(client.authorized, true);
  assert.equal(client.alpnProtocol, 'h2');
  assert.equal(client.getPeerCertificate().subject.CN, ORIGIN_HOST);
  await once(client, 'end');
  assert.equal(receivedSni, ORIGIN_HOST);
  assert.equal(Buffer.concat(chunks).toString(), 'origin TLS response');
  assert.equal(connections, 1); assert.equal(connected, true);
  assert.equal(discovery.state.connections[0].status, 'encrypted');
  assert.equal(discovery.state.connections[0].clientId, undefined);
});

test('HTTPS origin DNS failure closes the client instead of leaving it pending', async (t) => {
  let error;
  const proxy = createTcpProxy({ port: 443, lookup: (_host, _options, cb) => cb(new Error('Origin DNS unavailable')),
    onError: (value) => { error = value; } });
  const port = await listen(proxy); t.after(() => proxy.close());
  const client = net.connect(port, '127.0.0.1');
  client.on('error', () => {});
  await once(client, 'close');
  assert.match(error.message, /Origin DNS unavailable/);
});
