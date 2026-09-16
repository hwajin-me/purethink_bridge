import fs from 'node:fs';
import path from 'node:path';

// Bounded disk and memory history; never record payloads or credentials.
export function createAccessLog({ directory, maxBytes = 5 * 1024 * 1024, limit = 500 }) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'access.jsonl');
  const state = { ports: {}, recent: [], lastError: null };
  function record(event) {
    const entry = { time: new Date().toISOString(), ...event };
    state.recent.push(entry);
    if (state.recent.length > limit) state.recent.shift();
    try {
      if (fs.existsSync(filename) && fs.statSync(filename).size >= maxBytes) fs.renameSync(filename, `${filename}.1`);
      fs.appendFileSync(filename, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) { state.lastError = error.message; }
  }
  function observe(server, { port, mode }) {
    state.ports[port] = { accepted: 0, active: 0, lastAccess: null, mode: typeof mode === 'function' ? mode() : mode };
    server.on('connection', (socket) => {
      const stats = state.ports[port];
      stats.accepted++; stats.active++; stats.lastAccess = new Date().toISOString();
      const peer = { port, mode: typeof mode === 'function' ? mode() : mode, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort };
      record({ ...peer, event: 'connect' });
      socket.once('close', (hadError) => {
        stats.active--;
        record({ ...peer, event: 'close', hadError, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten });
      });
    });
    return server;
  }
  return { state, observe, record };
}
