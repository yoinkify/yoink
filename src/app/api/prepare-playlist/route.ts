import { withRequestLogging } from "@/lib/request-logging";
import { logEvent } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import type { TrackInfo } from "@/lib/spotify";
import { rateLimit } from "@/lib/ratelimit";
import { buildEnvelopeMetadata, packEnvelope } from "@/lib/envelope";
import { getClientIp } from "@/lib/request-privacy";
import { verifyProofOfWork } from "@/lib/proof-of-work-verify";
import { enrichPlaylistTracks, loadPlaylistWithFallback } from "@/lib/playlist-workflow";
import { prepareTrackAssets } from "@/lib/track-prep";

export const maxDuration = 300;

async function prepareTrack(
  track: TrackInfo,
  requestedFormat: string | undefined,
  genreSource?: string,
  syncedLyrics?: boolean,
): Promise<Buffer> {
  const { audio, artBuffer, catalogIds, embeddedLyrics } = await prepareTrackAssets(track, {
    requestedFormat,
    genreSource,
    syncedLyrics,
  });

  const metadata = buildEnvelopeMetadata(track, audio, embeddedLyrics, catalogIds);
  return packEnvelope(metadata, audio.buffer, artBuffer);
}

async function handlePOST(request: NextRequest) {
  try {
    const ip = getClientIp(request);

    const { allowed, retryAfter } = rateLimit(`prepare-playlist:${ip}`, 5, 60_000);
    if (!allowed) {
      return NextResponse.json(
        { error: `slow down — try again in ${retryAfter}s`, rateLimit: true },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const body = await request.json();
    const { url, format: requestedFormat, genreSource, syncedLyrics, pow } = body;
    if (pow && !verifyProofOfWork(pow)) {
      return NextResponse.json({ error: "verification failed — please try again" }, { status: 403 });
    }

    logEvent("api.prepare-playlist.request_received");

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    const MAX_TRACKS = 200;

    const playlist = await loadPlaylistWithFallback(url);

    if (!playlist) {
      return NextResponse.json({ error: "couldn't load this right now" }, { status: 503 });
    }

    playlist.tracks = await enrichPlaylistTracks(playlist.tracks);

    if (!playlist.tracks.length) {
      return NextResponse.json({ error: "Playlist has no tracks" }, { status: 400 });
    }
    if (playlist.tracks.length > MAX_TRACKS) {
      return NextResponse.json(
        { error: `playlist too large — max ${MAX_TRACKS} tracks on free tier` },
        { status: 400 }
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        };

        send({ type: "start", total: playlist!.tracks.length });

        const CONCURRENCY = 2;
        const MAX_RETRIES = 2;

        const prepareWithRetry = async (track: TrackInfo): Promise<Buffer> => {
          let lastError: unknown;
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
              return await prepareTrack(track, requestedFormat, genreSource, syncedLyrics === true);
            } catch (err) {
              lastError = err;
              if (attempt < MAX_RETRIES) {
                logEvent("api.prepare-playlist.track_attempt_failed_retrying");
                await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
              }
            }
          }
          throw lastError;
        };

        for (let i = 0; i < playlist!.tracks.length; i += CONCURRENCY) {
          // Random delay between batches to avoid hammering sources
          if (i > 0) {
            const delay = 1000 + Math.random() * 2000; // 1-3s
            await new Promise((r) => setTimeout(r, delay));
          }

          const batch = playlist!.tracks.slice(i, i + CONCURRENCY);
          const batchIndices = batch.map((_, j) => i + j);

          send({ type: "batch", indices: batchIndices });

          const batchResults = await Promise.allSettled(
            batch.map(async (track, j) => {
              if (j > 0) await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000)); // stagger within batch
              return prepareWithRetry(track);
            })
          );

          for (let j = 0; j < batchResults.length; j++) {
            const result = batchResults[j];
            const trackIndex = i + j;
            if (result.status === "fulfilled") {
              const envelope = result.value;
              send({ type: "track", index: trackIndex, size: envelope.length });
              controller.enqueue(envelope);
            } else {
              send({ type: "error", index: trackIndex });
              logEvent("api.prepare-playlist.track_failed_after_attempts");
            }
          }
        }

        send({ type: "done" });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Content-Type": "playlist-envelope-stream",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Playlist preparation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withRequestLogging(handlePOST, "api.prepare-playlist.started");
