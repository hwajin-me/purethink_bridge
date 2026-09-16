// Example protocol, not a reverse-engineered manufacturer protocol.
// Each request is one UTF-8 JSON line: {"id":1,"op":"ping|get|set","key":"...","value":...}.
export function createHandler({ port, config }) {
  const values = new Map();
  const maxKeys = config.maxKeys || 1000;
  return (socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(60000, () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) return socket.destroy();
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let reply;
        try {
          const request = JSON.parse(line);
          if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be an object');
          reply = { id: request.id ?? null, port, ok: true };
          if (request.op === 'ping') reply.value = 'pong';
          else if (['get', 'set', 'delete'].includes(request.op) && typeof request.key === 'string') {
            if (request.op === 'set') {
              if (!values.has(request.key) && values.size >= maxKeys) throw new Error('Store full');
              values.set(request.key, request.value ?? null);
            }
            if (request.op === 'delete') values.delete(request.key);
            reply.value = values.get(request.key) ?? null;
          } else throw new Error('Unknown operation or invalid key');
        } catch (error) { reply = { port, ok: false, error: error.message }; }
        if (!socket.write(`${JSON.stringify(reply)}\n`)) {
          // Bound slow-reader memory rather than accumulate unbounded responses.
          socket.destroy(); return;
        }
      }
    });
    socket.on('end', () => socket.end());
  };
}
