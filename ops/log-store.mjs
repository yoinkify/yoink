import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import events from "../src/lib/log-events.json" with { type: "json" };

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DAILY_BYTES = 5 * 1024 * 1024;

// Reconstruct every record from an allowlist. Never serialize extra fields,
// raw console output, exceptions, request bodies, or upstream responses.
export function sanitizeRecord(message, now = Date.now()) {
  if (!message || message.type !== "yoink-log" || typeof message.event !== "string"
      || !Object.hasOwn(events, message.event)) return null;
  if (message.requestId !== undefined && (typeof message.requestId !== "string"
      || !/^req-[a-f0-9]{32}$/.test(message.requestId))) return null;
  return {
    time: new Date(now).toISOString(),
    event: message.event,
    level: events[message.event],
    ...(Number.isInteger(message.status) && message.status >= 100 && message.status <= 599 ? { status: message.status } : {}),
    ...(message.requestId ? { requestId: message.requestId } : {}),
  };
}

export function pruneLogs(directory, now = Date.now()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(directory)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const dayStart = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`);
    if (dayStart + RETENTION_MS <= now) unlinkSync(join(directory, name));
  }
}

export function createLogStore(directory, clock = Date.now) {
  pruneLogs(directory, clock());
  return {
    prune() { pruneLogs(directory, clock()); },
    write(message) {
      const now = clock();
      const record = sanitizeRecord(message, now);
      if (!record) return false;
      // Also prune on writes, including the first write after UTC midnight.
      pruneLogs(directory, now);
      const file = join(directory, `${record.time.slice(0, 10)}.jsonl`);
      const line = JSON.stringify(record) + "\n";
      let size = 0;
      try { size = statSync(file).size; } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (size + Buffer.byteLength(line) > MAX_DAILY_BYTES) return false;
      appendFileSync(file, line, { mode: 0o600 });
      return true;
    },
  };
}
