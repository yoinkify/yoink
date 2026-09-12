import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createLogStore, sanitizeRecord } from "../../ops/log-store.mjs";

const directories: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "yoink-logs-test-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("production log storage", () => {
  it("reconstructs records and discards sensitive extras, unknown events, and malformed IDs", () => {
    const message = { type: "yoink-log", event: "request.failed", requestId: `req-${"a".repeat(32)}`, status: 503,
      ip: "192.0.2.1", email: "private@example.test", message: "secret", time: "user-controlled", error: { stack: "secret" } };
    expect(sanitizeRecord(message, 0)).toEqual({ time: "1970-01-01T00:00:00.000Z", event: "request.failed", level: "error", requestId: message.requestId, status: 503 });
    expect(sanitizeRecord({ ...message, event: "toString" })).toBeNull();
    expect(sanitizeRecord({ ...message, requestId: "req-private@example.test" })).toBeNull();
    expect(sanitizeRecord("raw stack trace")).toBeNull();
  });

  it("deletes expired daily files at startup, during idle cleanup, and before writes", () => {
    const dir = temp();
    let now = Date.parse("2026-09-07T23:59:59Z");
    writeFileSync(join(dir, "2026-08-30.jsonl"), "old");
    writeFileSync(join(dir, "unrelated.txt"), "keep");
    const store = createLogStore(dir, () => now);
    expect(readdirSync(dir)).toEqual(["unrelated.txt"]);
    store.write({ type: "yoink-log", event: "request.failed" });
    now = Date.parse("2026-09-14T00:00:00Z");
    store.prune();
    expect(readdirSync(dir)).toEqual(["unrelated.txt"]);
    writeFileSync(join(dir, "2026-09-06.jsonl"), "old");
    store.write({ type: "yoink-log", event: "runtime.started" });
    expect(readdirSync(dir).sort()).toEqual(["2026-09-14.jsonl", "unrelated.txt"]);
  });

  it("bounds storage even during an error flood", () => {
    const dir = temp();
    const store = createLogStore(dir, () => Date.parse("2026-09-07T12:00:00Z"));
    writeFileSync(join(dir, "2026-09-07.jsonl"), Buffer.alloc(5 * 1024 * 1024));
    expect(store.write({ type: "yoink-log", event: "request.failed" })).toBe(false);
  });

  it("drops raw child output and persists only validated IPC events through the real launcher", async () => {
    const dir = temp();
    const fixture = join(dir, "child.cjs");
    writeFileSync(fixture, `console.log('private@example.test'); console.error('Bearer secret');
      process.send({type:'yoink-log',event:'request.failed',requestId:'req-${"a".repeat(32)}',email:'private@example.test'}, () => process.disconnect());`);
    const child = spawn(process.execPath, ["ops/start-private.mjs", fixture], {
      cwd: process.cwd(), env: { ...process.env, YOINK_LOG_DIR: join(dir, "logs") }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect(code).toBe(0);
    expect(output).toBe("");
    const logs = readdirSync(join(dir, "logs")).map((name) => readFileSync(join(dir, "logs", name), "utf8")).join("");
    expect(logs).toContain("request.failed");
    expect(logs).toContain(`req-${"a".repeat(32)}`);
    expect(logs).not.toMatch(/private|Bearer|secret/);
  });
});
