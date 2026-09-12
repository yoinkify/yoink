import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { logEvent, type LogEvent } from "@/lib/logger";
import { getRequestLogId } from "@/lib/request-privacy";
import { withRequestLogging } from "@/lib/request-logging";

afterEach(() => vi.restoreAllMocks());

describe("private request diagnostics", () => {
  it("isolates concurrent requests, ignores supplied IDs, and preserves nested context", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const handler = withRequestLogging(async (request) => {
      const id = getRequestLogId(request);
      await new Promise((resolve) => setTimeout(resolve, request.nextUrl.searchParams.has("slow") ? 15 : 1));
      logEvent("spotify.track_api_error", 429);
      return Response.json({ id });
    }, "api.prepare.started");
    const makeRequest = (query: string) => new NextRequest(`https://example.test/api?${query}`, {
      headers: { "x-request-id": "req-attacker", "cf-connecting-ip": "192.0.2.1", cookie: "private=secret" },
    });
    const responses = await Promise.all([handler(makeRequest("slow&email=private@example.test")), handler(makeRequest("q=private-search"))]);
    const ids = responses.map((response) => response.headers.get("X-Request-ID"));
    expect(new Set(ids).size).toBe(2);
    for (const [index, response] of responses.entries()) {
      expect(ids[index]).toMatch(/^req-[a-f0-9]{32}$/);
      expect(await response.json()).toEqual({ id: ids[index] });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const logs = output.mock.calls.map(([line]) => JSON.parse(line));
    for (const id of ids) {
      expect(logs.filter((record) => record.requestId === id).map((record) => record.event))
        .toEqual(["api.prepare.started", "spotify.track_api_error", "request.completed"]);
    }
    expect(JSON.stringify(logs)).not.toMatch(/private|192\.0\.2\.1|attacker|cookie/);
    logEvent("runtime.started");
    expect(JSON.parse(output.mock.calls.at(-1)![0])).not.toHaveProperty("requestId");
  });

  it("returns a support ID for handled and unhandled errors without logging exception content", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    for (const fail of [false, true]) {
      const handler = withRequestLogging(async () => {
        if (fail) throw new Error("private@example.test?token=secret");
        return Response.json({ error: "slow down", rateLimit: true }, { status: 429, headers: { "Retry-After": "12" } });
      }, "api.prepare.started");
      const response = await handler(new NextRequest("https://example.test"));
      const body = await response.json();
      expect(response.status).toBe(fail ? 500 : 429);
      expect(body.requestId).toBe(response.headers.get("X-Request-ID"));
      expect(body.requestId).toMatch(/^req-[a-f0-9]{32}$/);
      if (!fail) expect(response.headers.get("Retry-After")).toBe("12");
    }
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/private|secret/);
  });

  it("preserves binary streams and their async logging context", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const handler = withRequestLogging(async () => new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          logEvent("api.prepare-playlist.track_failed_after_attempts");
          controller.enqueue(new Uint8Array([0, 255, 3]));
          controller.close();
        }, 1);
      },
    }), { headers: { "Content-Type": "application/octet-stream" } }), "api.prepare-playlist.started");
    const response = await handler(new NextRequest("https://example.test"));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 3]));
    expect(JSON.parse(output.mock.calls.at(-1)![0]).requestId).toBe(response.headers.get("X-Request-ID"));
  });

  it("rejects unknown events and arbitrary status fields at runtime", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    logEvent("private@example.test" as LogEvent);
    logEvent("toString" as LogEvent);
    expect(output).not.toHaveBeenCalled();
    logEvent("spotify.track_api_error", "private" as unknown as number);
    expect(JSON.parse(output.mock.calls[0][0])).not.toHaveProperty("status");
  });
});
