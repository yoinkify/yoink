import { logEvent } from "@/lib/logger";
import type { TrackInfo } from "./spotify";

interface TidalToken {
  access_token: string;
  expires_at: number;
}

let cachedToken: TidalToken | null = null;

async function getTidalSession(): Promise<string | null> {
  // Check cached token
  if (cachedToken && Date.now() < cachedToken.expires_at) {
    return cachedToken.access_token;
  }

  const refreshToken = process.env.TIDAL_REFRESH_TOKEN;
  const clientId = process.env.TIDAL_CLIENT_ID;
  const clientSecret = process.env.TIDAL_CLIENT_SECRET;

  if (!refreshToken || !clientId) {
    return process.env.TIDAL_ACCESS_TOKEN || null;
  }

  try {
    const params: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      scope: "r_usr w_usr",
    };
    if (clientSecret) {
      params.client_secret = clientSecret;
    }

    const res = await fetch("https://auth.tidal.com/v1/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {

      logEvent("tidal.token_refresh_failed", res.status);
      return process.env.TIDAL_ACCESS_TOKEN || null;
    }

    const data = await res.json();
    cachedToken = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
    };

    return cachedToken.access_token;
  } catch {
    logEvent("tidal.token_refresh_error");
    return process.env.TIDAL_ACCESS_TOKEN || null;
  }
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s*[\(\[](feat\.|ft\.|featuring)[^\)\]]*[\)\]]/gi, "")
    .replace(/\s*-\s*(remastered?|radio edit|single version|album version|original mix)(\s+\d+)?$/gi, "")
    .replace(/\s*[\(\[](remastered?|\d{4}\s+remaster|radio edit|single version|album version)[\)\]]/gi, "")
    .trim();
}

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function artistMatches(resultArtist: string, queryArtist: string): boolean {
  const a = normalizeStr(resultArtist);
  const b = normalizeStr(queryArtist);
  return a.includes(b) || b.includes(a);
}

export async function searchTidalByTitleArtist(track: TrackInfo): Promise<string | null> {
  const token = await getTidalSession();
  if (!token) return null;

  try {
    const query = `${track.artist} ${cleanTitle(track.name)}`;
    const res = await fetch(
      `https://api.tidal.com/v1/search/tracks?query=${encodeURIComponent(query)}&countryCode=US&limit=10`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!res.ok) {
      logEvent("tidal.title_search_failed", res.status);
      return null;
    }

    const data = await res.json();
    const items: Array<{ id: number; duration: number; artist?: { name: string }; artists?: Array<{ name: string }> }> = data.items || [];

    for (const item of items) {
      const artistName = item.artist?.name || item.artists?.[0]?.name || "";
      if (verifyMatch(item.duration, track) && artistMatches(artistName, track.artist)) {
        return String(item.id);
      }
    }

    return null;
  } catch {
    logEvent("tidal.title_search_error");
    return null;
  }
}

export async function lookupTidalByIsrc(isrc: string): Promise<string | null> {
  const token = await getTidalSession();
  if (!token) return null;

  try {
    const res = await fetch(
      `https://openapi.tidal.com/v2/tracks?filter[isrc]=${encodeURIComponent(isrc)}&countryCode=US`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!res.ok) {
      logEvent("tidal.isrc_lookup_failed", res.status);
      return null;
    }

    const data = await res.json();
    const track = data.data?.[0];
    return track?.id ? String(track.id) : null;
  } catch {
    logEvent("tidal.isrc_lookup_error");
    return null;
  }
}

export async function lookupTidalVideoCover(track: TrackInfo): Promise<string | null> {
  const token = await getTidalSession();
  if (!token) return null;

  try {
    // Find the Tidal track first
    let tidalId: string | null = null;
    if (track.isrc) {
      tidalId = await lookupTidalByIsrc(track.isrc);
    }
    if (!tidalId) {
      tidalId = await searchTidalByTitleArtist(track);
    }
    if (!tidalId) return null;

    // Fetch track details from v1 API (includes album with videoCover)
    const res = await fetch(
      `https://api.tidal.com/v1/tracks/${tidalId}?countryCode=US`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const videoCover = data.album?.videoCover;
    if (!videoCover) return null;

    return `https://resources.tidal.com/videos/${videoCover}/1280x1280.mp4`;
  } catch {
    logEvent("tidal.video_cover_lookup_error");
    return null;
  }
}

type TidalQuality = "HI_RES_LOSSLESS" | "LOSSLESS" | "HIGH";

export interface TidalAudioResult {
  buffer: Buffer;
  format: "flac" | "mp3";
  bitrate: number;
  quality: TidalQuality;
}

// v1 API — returns direct unencrypted stream URLs for LOSSLESS/HIGH tiers.
// v2 (openapi.tidal.com/v2/trackManifests) always returns FairPlay-encrypted HLS
// which requires an Apple FairPlay license server to decrypt; unusable here.
async function getManifest(
  tidalId: string,
  preferHiRes: boolean,
  token: string
): Promise<{ url: string; quality: TidalQuality } | null> {
  const qualities: TidalQuality[] = preferHiRes
    ? ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH"]
    : ["LOSSLESS", "HIGH"];

  for (const quality of qualities) {
    try {
      const res = await fetch(
        `https://api.tidal.com/v1/tracks/${tidalId}/playbackinfopostpaywall/v4?audioquality=${quality}&playbackmode=STREAM&assetpresentation=FULL`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!res.ok) {
        logEvent("tidal.v1_quality_not_available", res.status);
        continue;
      }

      const text = await res.text();
      if (text.trimStart().startsWith("<")) {
        logEvent("tidal.v1_quality_received_xml_response_skipping");
        continue;
      }

      const data = JSON.parse(text);

      if (data.encryptionType && data.encryptionType !== "NONE") {
        logEvent("tidal.encrypted_stream_skipping");
        continue;
      }

      // Manifest is base64-encoded JSON
      const manifest = JSON.parse(Buffer.from(data.manifest, "base64").toString());
      const url = manifest.urls?.[0];
      if (!url) continue;

      return { url, quality: data.audioQuality || quality };
    } catch {
      logEvent("tidal.v1_playback_info_error");
    }
  }

  return null;
}

function parseTidalDuration(isoDuration: string): number {
  // Parse ISO 8601 duration like "PT3M17S" → seconds
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0");
  const minutes = parseInt(match[2] || "0");
  const seconds = parseInt(match[3] || "0");
  return hours * 3600 + minutes * 60 + seconds;
}

function verifyMatch(tidalDurationSec: number, track: TrackInfo): boolean {
  const durationMs = tidalDurationSec * 1000;
  return Math.abs(durationMs - track.durationMs) <= 5000;
}

export async function fetchTidalAudio(
  tidalId: string,
  track: TrackInfo,
  preferHiRes: boolean
): Promise<TidalAudioResult | null> {
  const token = await getTidalSession();
  if (!token) return null;

  try {
    // Verify track metadata before downloading (v2 API)
    const metaRes = await fetch(
      `https://openapi.tidal.com/v2/tracks/${tidalId}?countryCode=US`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.api+json",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (metaRes.ok) {
      const meta = await metaRes.json();
      const duration = meta.data?.attributes?.duration;
      if (duration) {
        const durationSec = typeof duration === "string"
          ? parseTidalDuration(duration)
          : duration;
        if (!verifyMatch(durationSec, track)) {
          logEvent("tidal.duration_mismatch_skipping");
          return null;
        }
      }
    }

    // Get streaming manifest
    const streamInfo = await getManifest(tidalId, preferHiRes, token);
    if (!streamInfo) {
      logEvent("tidal.no_available_quality_tier");
      return null;
    }

    logEvent("tidal.streaming_quality");

    const audioRes = await fetch(streamInfo.url, {
      signal: AbortSignal.timeout(120000),
    });

    if (!audioRes.ok) {
      logEvent("tidal.audio_download_failed", audioRes.status);
      return null;
    }

    const buffer = Buffer.from(await audioRes.arrayBuffer());
    if (buffer.length === 0) return null;

    const isFlac = streamInfo.quality === "HI_RES_LOSSLESS" || streamInfo.quality === "LOSSLESS";

    return {
      buffer,
      format: isFlac ? "flac" : "mp3",
      bitrate: isFlac ? 0 : 320,
      quality: streamInfo.quality,
    };
  } catch {
    logEvent("tidal.fetch_error");
    return null;
  }
}
