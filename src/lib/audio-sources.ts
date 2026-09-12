import { logEvent } from "@/lib/logger";
import type { TrackInfo } from "./spotify";
import { resolveSonglink } from "./songlink";
import { fetchDeezerAudio, lookupDeezerByIsrc, searchDeezerByTitleArtist } from "./deezer";
import { lookupTidalByIsrc, searchTidalByTitleArtist, fetchTidalAudio } from "./tidal";
import { withTidalThrottle } from "./semaphore";
import { searchYouTube, getAudioStreamUrl, ytdlpDownload } from "./youtube";
import type { AudioQualityInfo } from "./ffprobe";
import type { AcoustIdResult } from "./acoustid";

export interface AudioResult {
  buffer: Buffer;
  source: "deezer" | "tidal" | "youtube";
  format: "mp3" | "flac" | "webm";
  bitrate: number;
  qualityInfo?: AudioQualityInfo;
  verification?: AcoustIdResult;
}

async function getDeezerIdForTrack(track: TrackInfo): Promise<string | null> {
  // Fast path: ISRC lookup via Deezer public API (no rate limit)
  if (track.isrc) {
    logEvent("audio-sources.looking_up_deezer_by_isrc");
    const id = await lookupDeezerByIsrc(track.isrc);
    if (id) return id;
    logEvent("audio-sources.isrc_lookup_returned_nothing");
  }

  // Second path: Song.link fallback
  const links = await resolveSonglink(track.spotifyUrl);
  if (links?.deezerId) return links.deezerId;

  // Third path: title/artist search on Deezer directly
  logEvent("audio-sources.trying_deezer_title_search_for");
  return searchDeezerByTitleArtist(track);
}

async function tryDeezer(track: TrackInfo, preferFlac: boolean): Promise<AudioResult | null> {
  try {
    logEvent("audio-sources.trying_deezer_for");
    const deezerId = await getDeezerIdForTrack(track);
    if (!deezerId) {
      logEvent("audio-sources.no_deezer_id_found");
      return null;
    }

    logEvent("audio-sources.got_deezer_id");
    const result = await fetchDeezerAudio(deezerId, track, preferFlac);
    if (!result) {
      logEvent("audio-sources.deezer_fetch_returned_null");
      return null;
    }

    logEvent("audio-sources.deezer_success");
    return {
      buffer: result.buffer,
      source: "deezer",
      format: result.format,
      bitrate: result.bitrate,
    };
  } catch {
    logEvent("audio-sources.deezer_error");
    return null;
  }
}

async function getTidalIdForTrack(track: TrackInfo): Promise<string | null> {
  // Fast path: ISRC lookup via Tidal API
  if (track.isrc) {
    logEvent("audio-sources.looking_up_tidal_by_isrc");
    const id = await lookupTidalByIsrc(track.isrc);
    if (id) return id;
    logEvent("audio-sources.tidal_isrc_lookup_returned_nothing");
  }

  // Second path: Song.link fallback
  const links = await resolveSonglink(track.spotifyUrl);
  if (links?.tidalId) return links.tidalId;

  // Third path: title/artist search on Tidal directly
  logEvent("audio-sources.trying_tidal_title_search_for");
  return searchTidalByTitleArtist(track);
}

async function tryTidal(track: TrackInfo, preferHiRes: boolean): Promise<AudioResult | null> {
  try {
    logEvent("audio-sources.trying_tidal_for");
    const tidalId = await getTidalIdForTrack(track);
    if (!tidalId) {
      logEvent("audio-sources.no_tidal_id_found");
      return null;
    }

    logEvent("audio-sources.got_tidal_id");
    const result = await withTidalThrottle(() => fetchTidalAudio(tidalId, track, preferHiRes));
    if (!result) {
      logEvent("audio-sources.tidal_fetch_returned_null");
      return null;
    }

    logEvent("audio-sources.tidal_success");
    return {
      buffer: result.buffer,
      source: "tidal",
      format: result.format,
      bitrate: result.bitrate,
    };
  } catch {
    logEvent("audio-sources.tidal_error");
    return null;
  }
}

async function tryYouTube(track: TrackInfo): Promise<AudioResult> {
  const query = `${track.artist} - ${track.name}`;
  const videoId = await searchYouTube(query, {
    artist: track.artist,
    title: track.name,
    album: track.album || undefined,
    durationMs: track.durationMs,
  });
  if (!videoId) {
    throw new Error("couldn't find this track on any source — it may not be available yet or the title may differ on streaming platforms");
  }

  // Try piped stream URL first
  try {
    const audioUrl = await getAudioStreamUrl(videoId);

    const ALLOWED_AUDIO_HOSTS = [
      "googlevideo.com",
      "youtube.com",
      "proxy.piped.private.coffee",
    ];

    // Also allow the configured piped instance's hostname
    if (process.env.PIPED_API_URL) {
      try {
        const pipedHost = new URL(process.env.PIPED_API_URL).hostname;
        ALLOWED_AUDIO_HOSTS.push(pipedHost);
      } catch {}
    }

    const parsed = new URL(audioUrl);
    const allowed = ALLOWED_AUDIO_HOSTS.some((host) =>
      parsed.hostname === host || parsed.hostname.endsWith("." + host)
    );
    if (!allowed) throw new Error("not allowed host");

    const audioRes = await fetch(audioUrl, {
      signal: AbortSignal.timeout(60000),
    });

    if (!audioRes.ok) throw new Error(`piped fetch failed: ${audioRes.status}`);

    const buffer = Buffer.from(await audioRes.arrayBuffer());
    if (buffer.length === 0) throw new Error("empty audio");

    return {
      buffer,
      source: "youtube",
      format: "webm",
      bitrate: 160,
    };
  } catch {
    logEvent("audio-sources.piped_stream_failed_trying_yt_dlp_direct_download");
  }

  // Fall back to yt-dlp direct download
  const result = await ytdlpDownload(videoId);
  if (!result || result.buffer.length === 0) {
    throw new Error("couldn't download audio from any source");
  }

  return {
    buffer: result.buffer,
    source: "youtube",
    format: result.format as "mp3" | "flac" | "webm",
    bitrate: 160,
  };
}

export async function fetchBestAudio(track: TrackInfo, preferFlac = false): Promise<AudioResult> {
  // Try Tidal first (hi-res capable, best quality)
  const tidalResult = await tryTidal(track, preferFlac);
  if (tidalResult) {
    // Skip ffprobe for Tidal — we already know format/bitrate from the API
    return tidalResult;
  }

  // Try Deezer second (CD lossless, no subscription cost)
  const deezerResult = await tryDeezer(track, preferFlac);
  if (deezerResult) {
    // Skip ffprobe for Deezer — we already know format/bitrate from the API
    return deezerResult;
  }

  // Fall back to YouTube (always WebM/Opus, no FLAC available)
  const ytResult = await tryYouTube(track);

  // Skip ffprobe and AcoustID for YouTube to reduce CPU usage.
  // ffprobe quality info is not critical for YouTube (always webm/opus ~160kbps),
  // and fpcalc (AcoustID) is very CPU-intensive.

  return ytResult;
}
