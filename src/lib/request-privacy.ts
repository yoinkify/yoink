import { newRequestId, requestLogContext } from "./logger";
import type { NextRequest } from "next/server";

export function getClientIp(request: NextRequest): string {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getRequestLogId(request: NextRequest): string {
  return requestLogContext.getStore()?.requestId ?? newRequestId();
}
