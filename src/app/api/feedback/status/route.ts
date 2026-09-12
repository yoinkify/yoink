import { withRequestLogging } from "@/lib/request-logging";
import { logEvent } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { getLinearClient } from "@/lib/linear";
import { readFeedbackTrackingToken } from "@/lib/feedback-tracking";
import { getClientIp } from "@/lib/request-privacy";

const MAX_TOKENS_PER_REQUEST = 10;

interface FeedbackStatusReport {
  token: string;
  identifier: string | null;
  title: string;
  status: string;
  stateType: string | null;
  updatedAt: string;
}

type FeedbackStatusLookup =
  | { report: FeedbackStatusReport }
  | { missingToken: string };

function toIsoString(value: string | Date | null | undefined): string {
  if (!value) return new Date(0).toISOString();

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

async function handlePOST(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    const { allowed, retryAfter } = rateLimit(`feedback-status:${ip}`, 30, 60_000);
    if (!allowed) {
      return NextResponse.json(
        { error: `slow down — try again in ${retryAfter}s`, rateLimit: true },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const body = await request.json().catch(() => null) as { tokens?: unknown } | null;
    const inputTokens = Array.isArray(body?.tokens)
      ? body.tokens.filter((token): token is string => typeof token === "string" && token.length > 0)
      : [];

    const tokens = Array.from(new Set(inputTokens)).slice(0, MAX_TOKENS_PER_REQUEST);
    if (!tokens.length) {
      return NextResponse.json({ reports: [], missingTokens: [] });
    }

    const decodedTokens = tokens.map((token) => ({ token, payload: readFeedbackTrackingToken(token) }));
    const validTokens = decodedTokens.flatMap((entry) => {
      return entry.payload ? [{ token: entry.token, payload: entry.payload }] : [];
    });
    const missingTokens = decodedTokens
      .filter((entry) => !entry.payload)
      .map((entry) => entry.token);

    const client = getLinearClient();
    const resolved: FeedbackStatusLookup[] = await Promise.all(validTokens.map(async ({ token, payload }) => {
      const issue = await client.issue(payload.issueId);
      if (!issue) return { missingToken: token };

      const state = await issue.state;
      return {
        report: {
          token,
          identifier: issue.identifier || null,
          title: issue.title,
          status: state?.name || "unknown",
          stateType: typeof state?.type === "string" ? state.type : null,
          updatedAt: toIsoString(issue.updatedAt),
        },
      };
    }));

    const reports = resolved
      .flatMap((entry): FeedbackStatusReport[] => ("report" in entry ? [entry.report] : []))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return NextResponse.json({
      reports,
      missingTokens: [...missingTokens, ...resolved.flatMap((entry) => ("missingToken" in entry ? [entry.missingToken] : []))],
    });
  } catch {
    logEvent("api.feedback.status.error");
    return NextResponse.json({ error: "something went wrong" }, { status: 500 });
  }
}

export const POST = withRequestLogging(handlePOST, "api.feedback.status.started");
