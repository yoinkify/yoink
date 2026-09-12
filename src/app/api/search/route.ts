import { withRequestLogging } from "@/lib/request-logging";
import { logEvent } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { searchTracks, type TrackInfo } from "@/lib/spotify";
import { searchItunesTrack } from "@/lib/itunes";
import { fetchDeezerTrackMetadata } from "@/lib/deezer";
import { rateLimit } from "@/lib/ratelimit";
import { getClientIp } from "@/lib/request-privacy";

async function searchDeezer(query: string, limit = 8): Promise<TrackInfo[]> {
  const res = await fetch(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.data?.length) return [];

  const results: TrackInfo[] = [];
  for (const item of data.data) {
    const meta = await fetchDeezerTrackMetadata(String(item.id));
    if (meta) {
      results.push({ ...meta, spotifyUrl: "", label: null, copyright: null } as TrackInfo);
    }
  }
  return results;
}

async function handleGET(request: NextRequest) {
  try {
    const ip = getClientIp(request);

    const { allowed, retryAfter } = rateLimit(`search:${ip}`, 15, 60_000);
    if (!allowed) {
      return NextResponse.json(
        { error: `slow down — try again in ${retryAfter}s`, rateLimit: true },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const q = request.nextUrl.searchParams.get("q")?.trim();
    if (!q) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    logEvent("api.search.request_received");

    // Try Spotify first
    try {
      const results = await searchTracks(q);
      return NextResponse.json({ results });
    } catch {
      logEvent("api.search.spotify_failed_trying_fallbacks");
    }

    // Fallback: Deezer search (free, no auth)
    const deezerResults = await searchDeezer(q);
    if (deezerResults.length > 0) {
      logEvent("api.search.got");
      return NextResponse.json({ results: deezerResults });
    }

    // Fallback: iTunes search (pass full query as title — iTunes handles it well)
    const itunesResult = await searchItunesTrack("", q);
    if (itunesResult) {
      logEvent("api.search.got_result_from_itunes");
      return NextResponse.json({ results: [itunesResult] });
    }

    return NextResponse.json({ error: "no results found" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withRequestLogging(handleGET, "api.search.started");
