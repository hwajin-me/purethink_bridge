import { createHash } from 'node:crypto';

// Track each outstanding broker echo, including identical concurrent publications.
// MQTT 3 has no publisher identity in delivered messages, so matching is necessarily
// bounded by a short timeout. Consume one token per echo, not all matching messages.
export function createMirrorTracker({ now = Date.now, ttl = 5000, maxEntries = 10000 } = {}) {
  const entries = new Map();
  let total = 0;
  function key(target, topic, payload) {
    return `${target}:${topic}:${createHash('sha256').update(payload).digest('hex')}`;
  }
  function prune() {
    const time = now();
    for (const [id, queue] of entries) {
      while (queue.length && queue[0] <= time) { queue.shift(); total--; }
      if (!queue.length) entries.delete(id);
    }
  }
  return {
    remember(target, topic, payload) {
      prune();
      const id = key(target, topic, payload);
      if (total >= maxEntries) {
        const first = entries.keys().next().value;
        const oldest = entries.get(first);
        oldest.shift(); total--;
        if (!oldest.length) entries.delete(first);
      }
      const queue = entries.get(id) || [];
      queue.push(now() + ttl); total++; entries.set(id, queue);
    },
    consume(target, topic, payload) {
      prune();
      const id = key(target, topic, payload); const queue = entries.get(id);
      if (!queue?.length) return false;
      queue.shift(); total--; if (!queue.length) entries.delete(id);
      return true;
    },
    clear(target) { for (const id of entries.keys()) if (id.startsWith(`${target}:`)) { total -= entries.get(id).length; entries.delete(id); } }
  };
}
