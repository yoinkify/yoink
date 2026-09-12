import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import events from "./log-events.json";

export type LogEvent = keyof typeof events;
export const requestLogContext = new AsyncLocalStorage<{ requestId: string }>();

export function newRequestId(): string {
  return `req-${randomBytes(16).toString("hex")}`;
}

// Only reviewed event names enter logs. No messages, errors, URLs, or fields
// supplied by a caller. Context contains a fresh ID, never request headers.
export function logEvent(event: LogEvent, status?: number): void {
  if (!Object.hasOwn(events, event)) return;
  const requestId = requestLogContext.getStore()?.requestId;
  const record = {
    type: "yoink-log",
    event,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(requestId && /^req-[a-f0-9]{32}$/.test(requestId) ? { requestId } : {}),
  };

  if (process.env.YOINK_PRIVATE_LOGGING === "1" && typeof process.send === "function" && process.connected) {
    // The production supervisor validates again and owns retention.
    try { process.send(record, () => {}); } catch { /* Never fall back to raw output. */ }
  } else if (process.env.NODE_ENV !== "production") {
    console.info(JSON.stringify(record));
  }
}
