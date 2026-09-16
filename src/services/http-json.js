// A local HTTP example service with explicit health/info endpoints.
export function createHandler({ port }) {
  return (req, res) => {
    const route = new URL(req.url, 'http://bridge.local').pathname;
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    const ok = route === '/health' || route === '/info';
    const body = JSON.stringify(ok ? { ok: true, port, service: 'bridge-simulator' } : { error: 'Not found' });
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
