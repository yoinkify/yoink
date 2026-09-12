import { withRequestLogging } from "@/lib/request-logging";
import { logEvent } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { detectPlatform } from "@/lib/spotify";
import { getSpotifyFromUrl, type SpotifyFromUrlResponse } from "@/lib/resolve-track";
import { rateLimit } from "@/lib/ratelimit";
import { getClientIp } from "@/lib/request-privacy";

const UNFURL_CACHE_TTL = 15 * 60 * 1000;
const UNFURL_CACHE_MAX = 200;
const unfurlCache = new Map<string, { data: SpotifyFromUrlResponse; expiresAt: number }>();
const YOINK_BRAND_NAME = "yoink";

function normalizeSpotifyCacheKey(input: string): string {
  try {
    const url = new URL(input);
    if (!url.hostname.includes("spotify.com")) return input.trim();
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return input.trim();
  }
}

function cloneWithRequestUrl(data: SpotifyFromUrlResponse, requestUrl: string): SpotifyFromUrlResponse {
  return {
    ...data,
    playlist_info: {
      ...data.playlist_info,
      external_url: requestUrl,
    },
  };
}

function withYoinkBranding(data: SpotifyFromUrlResponse, requestUrl: string, origin: string) {
  return {
    ...cloneWithRequestUrl(data, requestUrl),
    powered_by: {
      name: YOINK_BRAND_NAME,
      url: origin,
    },
  };
}

function getCachedUnfurl(key: string): SpotifyFromUrlResponse | null {
  const entry = unfurlCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    unfurlCache.delete(key);
    return null;
  }

  unfurlCache.delete(key);
  unfurlCache.set(key, entry);
  return entry.data;
}

function setCachedUnfurl(key: string, data: SpotifyFromUrlResponse) {
  if (unfurlCache.has(key)) {
    unfurlCache.delete(key);
  }

  unfurlCache.set(key, { data, expiresAt: Date.now() + UNFURL_CACHE_TTL });

  const now = Date.now();
  for (const [cacheKey, entry] of unfurlCache) {
    if (entry.expiresAt <= now) unfurlCache.delete(cacheKey);
  }

  while (unfurlCache.size > UNFURL_CACHE_MAX) {
    const oldestKey = unfurlCache.keys().next().value;
    if (!oldestKey) break;
    unfurlCache.delete(oldestKey);
  }
}

async function handleGET(request: NextRequest) {
  try {
    const ip = getClientIp(request);

    const { allowed, retryAfter } = rateLimit(`unfurl:${ip}`, 10, 60_000);
    if (!allowed) {
      return NextResponse.json(
        { error: `slow down — try again in ${retryAfter}s`, rateLimit: true },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const url = request.nextUrl.searchParams.get("url")?.trim();
    logEvent("api.unfurl.request_received");

    if (!url) {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    if (detectPlatform(url) !== "spotify") {
      return NextResponse.json({ error: "paste a spotify track, playlist, album, or artist link" }, { status: 400 });
    }

    const cacheKey = normalizeSpotifyCacheKey(url);
    const cached = getCachedUnfurl(cacheKey);
    if (cached) {
      return NextResponse.json(withYoinkBranding(cached, url, request.nextUrl.origin), {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
          "X-Powered-By": YOINK_BRAND_NAME,
          "X-Yoink-Cache": "HIT",
        },
      });
    }

    const data = await getSpotifyFromUrl(url, { enrichIsrc: false });
    if (!data) {
      return NextResponse.json({ error: "couldn't load this spotify url" }, { status: 404 });
    }

    setCachedUnfurl(cacheKey, data);

    return NextResponse.json(withYoinkBranding(data, url, request.nextUrl.origin), {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        "X-Powered-By": YOINK_BRAND_NAME,
        "X-Yoink-Cache": "MISS",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to unfurl url";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withRequestLogging(handleGET, "api.unfurl.started");
