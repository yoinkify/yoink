import type { NextRequest } from "next/server";
import { logEvent, newRequestId, requestLogContext, type LogEvent } from "./logger";

export function withRequestLogging(handler: (request: NextRequest) => Promise<Response>, startedEvent: LogEvent) {
  return (request: NextRequest): Promise<Response> => {
    const requestId = newRequestId();
    return requestLogContext.run({ requestId }, async () => {
      logEvent(startedEvent);
      try {
        let response = await handler(request);
        logEvent(response.status >= 500 ? "request.failed" : response.status >= 400 ? "request.rejected" : "request.completed", response.status);
        // Include the same support ID in all JSON errors, including validation
        // and rate-limit failures. Do not consume audio or streaming responses.
        if (!response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const body = await response.json();
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          response = Response.json({ ...body, requestId }, { status: response.status, headers });
        }
        response.headers.set("X-Request-ID", requestId);
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch {
        logEvent("request.failed");
        return Response.json(
          { error: "something went wrong — please try again", requestId },
          { status: 500, headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" } },
        );
      }
    });
  };
}
