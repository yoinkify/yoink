import { withRequestLogging } from "@/lib/request-logging";
import { logEvent } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getPlaylistInfo, getAlbumInfo, getArtistTopTracks, detectUrlType, detectPlatform, type TrackInfo } from "@/lib/spotify";
import { lookupTidalVideoCover } from "@/lib/tidal";
import { searchItunesTrack } from "@/lib/itunes";
import { resolveTrack, resolvePlaylist, resolveAlbum, resolveArtist, getSpotifyFromUrl, searchDeezerStructured, setCache, type SpotifyFromUrlResponse, type SpotifyFromUrlTrack } from "@/lib/resolve-track";
import { rateLimit } from "@/lib/ratelimit";
import { getClientIp } from "@/lib/request-privacy";
import { verifyProofOfWork } from "@/lib/proof-of-work-verify";
import { isCompilationAlbum } from "@/lib/audio-metadata";

const METADATA_CACHE_TTL = 15 * 60 * 1000;
const METADATA_CACHE_MAX = 200;
const MAX_FULL_METADATA_TRACKS = 200;
const metadataCache = new Map<string, { data: unknown; expiresAt: number }>();

function normalizeMetadataCacheKey(input: string): string {
  try {
    const url = new URL(input);
    if (!url.hostname.includes("spotify.com")) return input.trim();
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return input.trim();
  }
}

function getCachedMetadata(key: string): unknown | null {
  const entry = metadataCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    metadataCache.delete(key);
    return null;
  }

  metadataCache.delete(key);
  metadataCache.set(key, entry);
  return structuredClone(entry.data);
}

function setCachedMetadata(key: string, data: unknown) {
  if (metadataCache.has(key)) {
    metadataCache.delete(key);
  }

  metadataCache.set(key, { data, expiresAt: Date.now() + METADATA_CACHE_TTL });

  const now = Date.now();
  for (const [cacheKey, entry] of metadataCache) {
    if (entry.expiresAt <= now) metadataCache.delete(cacheKey);
  }

  while (metadataCache.size > METADATA_CACHE_MAX) {
    const oldestKey = metadataCache.keys().next().value;
    if (!oldestKey) break;
    metadataCache.delete(oldestKey);
  }
}

async function enrichWithVideoCover(track: TrackInfo): Promise<TrackInfo> {
  try {
    const videoCover = await Promise.race<string | null>([
      lookupTidalVideoCover(track),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 700)),
    ]);
    if (videoCover) track.videoCover = videoCover;
  } catch {
    // Never block metadata response
  }
  return track;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function mapUnfurlTrackToMetadataTrack(
  track: SpotifyFromUrlTrack,
  collection: SpotifyFromUrlResponse["playlist_info"],
): TrackInfo {
  const artist = track.artists.join("; ");
  const albumArtist = track.album_artists?.length
    ? track.album_artists.join("; ")
    : (collection.type === "album" || collection.type === "artist" ? artist : null);
  return {
    name: track.name,
    artist,
    albumArtist,
    compilation: track.compilation ?? isCompilationAlbum(albumArtist),
    album: track.album,
    albumArt: track.image?.url || track.thumb_image?.url || collection.images[0]?.url || "",
    duration: formatDuration(track.duration_ms),
    durationMs: track.duration_ms,
    isrc: track.external_ids?.isrc || null,
    genre: null,
    releaseDate: track.release_date || collection.release_date || null,
    spotifyUrl: track.external_url,
    explicit: track.explicit,
    trackNumber: track.track_number,
    discNumber: track.disc_number,
    label: null,
    copyright: track.copyright || null,
    totalTracks: track.total_tracks ?? (collection.type === "album" ? collection.total_tracks : null),
  };
}

function mapUnfurlToMetadata(data: SpotifyFromUrlResponse) {
  const tracks = data.tracks.map((track) => mapUnfurlTrackToMetadataTrack(track, data.playlist_info));
  if (data.playlist_info.type === "track") {
    return { type: "track" as const, track: tracks[0] || null };
  }

  return {
    type: "playlist" as const,
    playlist: {
      name: data.playlist_info.name,
      image: data.playlist_info.images[0]?.url || tracks[0]?.albumArt || "",
      tracks,
    },
  };
}

async function enrichMetadataTrack(track: TrackInfo): Promise<TrackInfo> {
  const [deezerResult, itunesResult] = await Promise.allSettled([
    searchDeezerStructured(track.name, track.artist, track.album || null),
    searchItunesTrack(track.artist, track.name, track.album || null),
  ]);

  let enriched = { ...track };

  if (deezerResult.status === "fulfilled" && deezerResult.value) {
    const deezer = deezerResult.value;
    enriched = {
      ...enriched,
      albumArtist: enriched.albumArtist || deezer.albumArtist,
      album: enriched.album || deezer.album,
      albumArt: enriched.albumArt || deezer.albumArt,
      isrc: enriched.isrc || deezer.isrc,
      releaseDate: enriched.releaseDate || deezer.releaseDate,
      totalTracks: enriched.totalTracks ?? deezer.totalTracks,
    };
  }

  if (itunesResult.status === "fulfilled" && itunesResult.value) {
    const itunes = itunesResult.value;
    enriched = {
      ...enriched,
      albumArtist: enriched.albumArtist || itunes.albumArtist,
      album: enriched.album || itunes.album,
      albumArt: enriched.albumArt || itunes.albumArt,
      genre: enriched.genre || itunes.genre,
      releaseDate: enriched.releaseDate || itunes.releaseDate,
      totalTracks: enriched.totalTracks ?? itunes.totalTracks,
      copyright: enriched.copyright || itunes.copyright,
      explicit: enriched.explicit || itunes.explicit,
      trackNumber: enriched.trackNumber ?? itunes.trackNumber,
      discNumber: enriched.discNumber ?? itunes.discNumber,
    };
  }

  return {
    ...enriched,
    compilation: enriched.compilation ?? isCompilationAlbum(enriched.albumArtist),
  };
}

async function enrichMetadataTracks(tracks: TrackInfo[]): Promise<TrackInfo[]> {
  const enriched: TrackInfo[] = [];

  for (let batchStart = 0; batchStart < tracks.length; batchStart += 5) {
    const batch = tracks.slice(batchStart, batchStart + 5);
    const resolved = await Promise.all(batch.map((track) => enrichMetadataTrack(track)));
    enriched.push(...resolved);
  }

  return enriched;
}

function cacheTrackForPrepare(url: string, response: unknown) {
  if (!response || typeof response !== "object") return;
  const obj = response as Record<string, unknown>;
  if (obj.type !== "track") return;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type: _type, _youtubeId, _originalPlatform, ...trackFields } = obj;
  setCache(url, trackFields as unknown as TrackInfo);
}

async function handlePOST(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    const { allowed, retryAfter } = rateLimit(`meta:${ip}`, 10, 60_000);
    if (!allowed) {
      logEvent("api.metadata.metadata_blocked");
      return NextResponse.json(
        { error: `slow down — try again in ${retryAfter}s`, rateLimit: true },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const body = await request.json();
    const { url, pow, fullMetadata } = body;

    // Proof-of-work is optional here: the site sends it, but public API callers can omit it.
    if (pow && !verifyProofOfWork(pow)) {
      return NextResponse.json({ error: "verification failed — please try again" }, { status: 403 });
    }

    logEvent("api.metadata.request_received");

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    const cacheKey = `${normalizeMetadataCacheKey(url)}::full=${fullMetadata === true ? "1" : "0"}`;

    // Check cache
    const cached = getCachedMetadata(cacheKey);
    if (cached) {
      cacheTrackForPrepare(url, cached);
      return NextResponse.json(cached);
    }

    const platform = detectPlatform(url);

    if (!platform) {
      return NextResponse.json(
        { error: "paste a spotify, apple music, or youtube link" },
        { status: 400 }
      );
    }

    // Playlists, albums, artists — Spotify API with embed scraping fallback
    if (platform === "spotify") {
      const urlType = detectUrlType(url);

      // Prefer the internal Spotify unfurl path first. The branches below are only fallback
      // paths when unfurl cannot resolve the URL.
      const unfurled = await getSpotifyFromUrl(url, { enrichIsrc: false });
      if (unfurled) {
        const mapped = mapUnfurlToMetadata(unfurled);
        if (mapped.type === "track" && mapped.track) {
          const baseTrack = fullMetadata ? await enrichMetadataTrack(mapped.track) : mapped.track;
          const enriched = await enrichWithVideoCover(baseTrack);
          const response = { type: "track", ...enriched };
          setCachedMetadata(cacheKey, response);
          setCache(url, enriched);
          return NextResponse.json(response);
        }
        if (mapped.type === "playlist") {
          const baseTracks = mapped.playlist.tracks;
          const enrichedTracks = fullMetadata
            ? await enrichMetadataTracks(baseTracks.slice(0, MAX_FULL_METADATA_TRACKS))
            : baseTracks;
          const playlist = fullMetadata
            ? { ...mapped.playlist, tracks: [...enrichedTracks, ...baseTracks.slice(MAX_FULL_METADATA_TRACKS)] }
            : mapped.playlist;
          const response = { type: "playlist", ...playlist };
          setCachedMetadata(cacheKey, response);
          return NextResponse.json(response);
        }
      }

      if (urlType === "playlist") {
        try {
          const playlist = await getPlaylistInfo(url);
          const response = { type: "playlist", ...playlist };
          setCachedMetadata(cacheKey, response);
          return NextResponse.json(response);
        } catch {
          logEvent("api.metadata.spotify_playlist_api_failed");
          const scraped = await resolvePlaylist(url);
          if (scraped) {
            const response = { type: "playlist", ...scraped };
            setCachedMetadata(cacheKey, response);
            return NextResponse.json(response);
          }
          return NextResponse.json({ error: "couldn't load playlist right now" }, { status: 503 });
        }
      }

      if (urlType === "album") {
        try {
          const album = await getAlbumInfo(url);
          const response = { type: "playlist", ...album };
          setCachedMetadata(cacheKey, response);
          return NextResponse.json(response);
        } catch {
          logEvent("api.metadata.spotify_album_api_failed");
          const scraped = await resolveAlbum(url);
          if (scraped) {
            const response = { type: "playlist", ...scraped };
            setCachedMetadata(cacheKey, response);
            return NextResponse.json(response);
          }
          return NextResponse.json({ error: "couldn't load album right now" }, { status: 503 });
        }
      }

      if (urlType === "artist") {
        try {
          const artist = await getArtistTopTracks(url);
          const response = { type: "playlist", ...artist };
          setCachedMetadata(cacheKey, response);
          return NextResponse.json(response);
        } catch {
          logEvent("api.metadata.spotify_artist_api_failed");
          const scraped = await resolveArtist(url);
          if (scraped) {
            const response = { type: "playlist", ...scraped };
            setCachedMetadata(cacheKey, response);
            return NextResponse.json(response);
          }
          return NextResponse.json({ error: "couldn't load artist right now" }, { status: 503 });
        }
      }

      if (!urlType) {
        return NextResponse.json(
          { error: "paste a track, playlist, album, or artist link" },
          { status: 400 }
        );
      }
    }

    // Single track — all platforms (Spotify track, Apple Music, YouTube)
    const result = await resolveTrack(url);
    if (result) {
      const enriched = await enrichWithVideoCover(result.track);
      const extra: Record<string, string> = {};
      if (result.youtubeVideoId) {
        extra._youtubeId = result.youtubeVideoId;
        extra._originalPlatform = "youtube";
      }
      const response = { type: "track", ...enriched, ...extra };
      setCachedMetadata(cacheKey, response);
      setCache(url, enriched);
      return NextResponse.json(response);
    }

    return NextResponse.json(
      { error: "couldn't find this track — try a different link" },
      { status: 404 }
    );
  } catch {
    logEvent("api.metadata.error");
    return NextResponse.json({ error: "failed to fetch info — please try again" }, { status: 500 });
  }
}

export const POST = withRequestLogging(handlePOST, "api.metadata.started");
