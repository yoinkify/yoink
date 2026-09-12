import { logEvent } from "@/lib/logger";
/**
 * Shared track resolution logic used by both /api/metadata and /api/download.
 *
 * Resolution chains:
 *   Spotify:     Spotify API → Song.link/Deezer → oEmbed parse → Deezer search → iTunes search
 *   Apple Music: iTunes lookup by ID → Song.link/Deezer → Spotify API
 *   YouTube:     Song.link cross-ref → Deezer/iTunes search by parsed title+artist → Piped fallback
 */

import { getTrackInfo, detectPlatform, extractYouTubeId, extractPlaylistId, extractAlbumId, extractArtistId, extractTrackId, type TrackInfo, type PlaylistInfo } from "./spotify";
import { getYouTubeTrackInfo } from "./youtube";
import { resolveToSpotify } from "./songlink";
import { fetchDeezerTrackMetadata, lookupDeezerByIsrc } from "./deezer";
import { searchItunesTrack, extractAppleMusicTrackId, lookupByItunesId } from "./itunes";
import { isCompilationAlbum } from "./audio-metadata";

export interface SpotifyFromUrlImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyFromUrlTrack {
  name: string;
  artists: string[];
  album_artists?: string[];
  album: string;
  image: SpotifyFromUrlImage | null;
  thumb_image: SpotifyFromUrlImage | null;
  id: string;
  external_ids?: { isrc: string | null };
  external_url: string;
  duration_ms: number;
  preview_url: string | null;
  explicit: boolean;
  release_date: string | null;
  track_number: number | null;
  disc_number: number | null;
  total_tracks?: number | null;
  copyright?: string | null;
  compilation?: boolean;
}

export interface SpotifyFromUrlCollectionInfo {
  id: string;
  type: "track" | "playlist" | "album" | "artist";
  name: string;
  description: string;
  owner: string;
  total_tracks: number;
  external_url: string;
  images: SpotifyFromUrlImage[];
  release_date?: string | null;
  from_source: "yoink";
}

export interface SpotifyFromUrlResponse {
  playlist_info: SpotifyFromUrlCollectionInfo;
  tracks: SpotifyFromUrlTrack[];
}

interface SpotifyFromUrlOptions {
  enrichIsrc?: boolean;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const cache = new Map<string, { track: TrackInfo; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000;

export function getCached(key: string): TrackInfo | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.track;
  return null;
}

export function setCache(key: string, track: TrackInfo) {
  cache.set(key, { track, ts: Date.now() });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL) cache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter for Spotify requests
// ---------------------------------------------------------------------------
let inFlight = 0;
const queue: (() => void)[] = [];
const MAX_CONCURRENT = 15;

async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const next = queue.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function findSpotifyImageUrl(value: unknown): string | null {
  if (typeof value === "string") {
    const isSpotifyImage = value.includes("spotifycdn.com/image/") || value.includes("i.scdn.co/image/");
    if (value.startsWith("https://") && isSpotifyImage) return value;
    return null;
  }

  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSpotifyImageUrl(item);
      if (found) return found;
    }
    return null;
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = findSpotifyImageUrl(nested);
    if (found) return found;
  }

  return null;
}

function normalizeSpotifyText(value: string): string {
  return value.replace(/\u00a0/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseSpotifyArtists(value: unknown): string[] {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map((artist) => {
        if (typeof artist === "string") return normalizeSpotifyText(artist);
        if (artist && typeof artist === "object" && typeof (artist as { name?: unknown }).name === "string") {
          return normalizeSpotifyText((artist as { name: string }).name);
        }
        return "";
      })
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((artist) => normalizeSpotifyText(artist))
      .filter(Boolean);
  }

  return [];
}

function extractSpotifyImages(value: unknown): SpotifyFromUrlImage[] {
  if (!value || typeof value !== "object") return [];

  const coverSources = (value as { coverArt?: { sources?: unknown } }).coverArt?.sources;
  if (Array.isArray(coverSources)) {
    return coverSources
      .map((source) => {
        if (!source || typeof source !== "object" || typeof (source as { url?: unknown }).url !== "string") return null;
        return {
          url: (source as { url: string }).url,
          width: typeof (source as { width?: unknown }).width === "number" ? (source as { width: number }).width : null,
          height: typeof (source as { height?: unknown }).height === "number" ? (source as { height: number }).height : null,
        };
      })
      .filter((image): image is SpotifyFromUrlImage => image !== null);
  }

  const visualImages = (value as { visualIdentity?: { image?: unknown } }).visualIdentity?.image;
  if (Array.isArray(visualImages)) {
    return visualImages
      .map((image) => {
        if (!image || typeof image !== "object" || typeof (image as { url?: unknown }).url !== "string") return null;
        return {
          url: (image as { url: string }).url,
          width: typeof (image as { maxWidth?: unknown }).maxWidth === "number" ? (image as { maxWidth: number }).maxWidth : null,
          height: typeof (image as { maxHeight?: unknown }).maxHeight === "number" ? (image as { maxHeight: number }).maxHeight : null,
        };
      })
      .filter((image): image is SpotifyFromUrlImage => image !== null);
  }

  return [];
}

function pickLargestSpotifyImage(images: SpotifyFromUrlImage[]): SpotifyFromUrlImage | null {
  if (!images.length) return null;
  return [...images].sort((a, b) => (b.width || 0) - (a.width || 0))[0] || null;
}

function pickSmallestSpotifyImage(images: SpotifyFromUrlImage[]): SpotifyFromUrlImage | null {
  if (!images.length) return null;
  return [...images].sort((a, b) => (a.width || Number.MAX_SAFE_INTEGER) - (b.width || Number.MAX_SAFE_INTEGER))[0] || null;
}

function getSpotifyEntityReleaseDate(entity: Record<string, unknown>): string | null {
  const releaseDate = entity.releaseDate;
  if (!releaseDate || typeof releaseDate !== "object") return null;

  const isoString = (releaseDate as { isoString?: unknown }).isoString;
  return typeof isoString === "string" ? isoString.split("T")[0] : null;
}

interface SpotifyPageMetadata {
  ogTitle: string | null;
  ogDescription: string | null;
  ogUrl: string | null;
  ogType: string | null;
  ogImage: string | null;
  description: string | null;
  musicReleaseDate: string | null;
  musicAlbumTrack: number | null;
  musicSongCount: number | null;
  musicMusicianDescription: string | null;
}

interface SpotifyEmbedSession {
  accessToken: string | null;
  entity: Record<string, unknown> | null;
}

interface SpotifyInternalCollectionData {
  name: string;
  owner: string;
  images: SpotifyFromUrlImage[];
  totalTracks: number;
  releaseDate: string | null;
  tracks: SpotifyFromUrlTrack[];
  entity: Record<string, unknown> | null;
}

function parseSpotifyMetaTags(html: string): SpotifyPageMetadata {
  const meta = new Map<string, string[]>();
  const patterns = [
    /<meta[^>]+(?:property|name)="([^"]+)"[^>]+content="([^"]*)"/gi,
    /<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="([^"]+)"/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const key = decodeHtmlEntities(pattern === patterns[0] ? match[1] : match[2]);
      const value = decodeHtmlEntities(pattern === patterns[0] ? match[2] : match[1]);
      const existing = meta.get(key) || [];
      existing.push(value);
      meta.set(key, existing);
    }
  }

  const first = (key: string) => meta.get(key)?.[0] || null;
  const toNumber = (key: string) => {
    const value = first(key);
    if (!value) return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    ogTitle: first("og:title"),
    ogDescription: first("og:description"),
    ogUrl: first("og:url"),
    ogType: first("og:type"),
    ogImage: first("og:image"),
    description: first("description"),
    musicReleaseDate: first("music:release_date"),
    musicAlbumTrack: toNumber("music:album:track"),
    musicSongCount: toNumber("music:song_count"),
    musicMusicianDescription: first("music:musician_description"),
  };
}

async function fetchSpotifyPageMetadata(
  type: "track" | "playlist" | "album" | "artist",
  id: string,
): Promise<SpotifyPageMetadata | null> {
  try {
    const res = await fetch(`https://open.spotify.com/${type}/${id}`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
      redirect: "follow",
    });
    if (!res.ok) return null;

    const html = await res.text();
    return parseSpotifyMetaTags(html);
  } catch {
    return null;
  }
}

function getSpotifyAlbumNameFromDescription(description: string | null): string | null {
  if (!description) return null;
  const parts = description.split(" · ");
  if (parts.length < 3) return null;

  const albumName = normalizeSpotifyText(parts[1]);
  return albumName || null;
}

function getSpotifyImageFallback(meta: SpotifyPageMetadata | null): SpotifyFromUrlImage[] {
  return meta?.ogImage ? [{ url: meta.ogImage, width: null, height: null }] : [];
}

function parseSpotifyCollectionMetadata(
  urlType: "track" | "playlist" | "album" | "artist",
  description: string | null,
): { owner: string | null } {
  if (!description) {
    return { owner: null };
  }

  if (urlType === "playlist") {
    const match = description.match(/^Playlist\s*·\s*(.+?)\s*·\s*\d+\s+items\s*·\s*(.+?)\s+saves$/i);
    return {
      owner: match ? normalizeSpotifyText(match[1]) : null,
    };
  }

  if (urlType === "album") {
    const match = description.match(/^(.+?)\s*·\s*album\s*·\s*.+$/i);
    return {
      owner: match ? normalizeSpotifyText(match[1]) : null,
    };
  }

  if (urlType === "artist") {
    return {
      owner: null,
    };
  }

  return { owner: null };
}

async function getSpotifyTrackPayload(
  trackId: string,
  fallback?: Partial<SpotifyFromUrlTrack>,
): Promise<SpotifyFromUrlTrack | null> {
  const [entity, meta] = await Promise.all([
    fetchSpotifyEmbedEntity("track", trackId),
    fetchSpotifyPageMetadata("track", trackId),
  ]);

  const images = entity ? extractSpotifyImages(entity) : getSpotifyImageFallback(meta);
  const title = typeof entity?.title === "string"
    ? normalizeSpotifyText(entity.title)
    : fallback?.name || meta?.ogTitle || "";
  const artists = entity
    ? parseSpotifyArtists(entity.artists)
    : (fallback?.artists || parseSpotifyArtists(meta?.musicMusicianDescription));

  if (!title || !artists.length) return null;

  const previewUrl = entity && typeof (entity.audioPreview as { url?: unknown } | undefined)?.url === "string"
    ? (entity.audioPreview as { url: string }).url
    : (fallback?.preview_url ?? null);

  return {
    name: title,
    artists,
    album: getSpotifyAlbumNameFromDescription(meta?.ogDescription || meta?.description || null) || fallback?.album || title,
    image: pickLargestSpotifyImage(images),
    thumb_image: pickSmallestSpotifyImage(images),
    id: trackId,
    external_ids: fallback?.external_ids,
    external_url: meta?.ogUrl || fallback?.external_url || `https://open.spotify.com/track/${trackId}`,
    duration_ms: typeof entity?.duration === "number" ? entity.duration : (fallback?.duration_ms || 0),
    preview_url: previewUrl,
    explicit: typeof entity?.isExplicit === "boolean" ? entity.isExplicit : (fallback?.explicit ?? false),
    release_date: getSpotifyEntityReleaseDate(entity || {}) || meta?.musicReleaseDate || fallback?.release_date || null,
    track_number: meta?.musicAlbumTrack || fallback?.track_number || null,
    disc_number: fallback?.disc_number ?? 1,
  };
}

async function enrichTrackWithIsrc(track: SpotifyFromUrlTrack): Promise<SpotifyFromUrlTrack> {
  if (track.external_ids?.isrc) return track;

  try {
    const deezer = await withLimit(() => searchDeezerStructured(track.name, track.artists[0] || null, track.album || null));
    if (!deezer?.isrc) return track;

    return {
      ...track,
      external_ids: { isrc: deezer.isrc },
    };
  } catch {
    return track;
  }
}

function extractSpotifyTrackIdFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const match = uri.match(/spotify:track:([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function mapSpotifyPathfinderImages(sources: unknown): SpotifyFromUrlImage[] {
  if (!Array.isArray(sources)) return [];

  return sources
    .map((source) => {
      if (!source || typeof source !== "object" || typeof (source as { url?: unknown }).url !== "string") return null;
      return {
        url: (source as { url: string }).url,
        width: typeof (source as { width?: unknown }).width === "number" ? (source as { width: number }).width : null,
        height: typeof (source as { height?: unknown }).height === "number" ? (source as { height: number }).height : null,
      };
    })
    .filter((image): image is SpotifyFromUrlImage => image !== null);
}

function mapSpotifyPathfinderArtists(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const items = (value as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const profile = (item as { profile?: { name?: unknown } }).profile;
      return typeof profile?.name === "string" ? normalizeSpotifyText(profile.name) : "";
    })
    .filter(Boolean);
}

function mapSpotifyPathfinderTrack(
  track: Record<string, unknown>,
  collectionType: "track" | "playlist" | "album" | "artist",
  index: number,
): SpotifyFromUrlTrack | null {
  const trackId = typeof track.id === "string"
    ? track.id
    : extractSpotifyTrackIdFromUri(typeof track.uri === "string" ? track.uri : null);
  if (!trackId) return null;

  const firstArtists = mapSpotifyPathfinderArtists(track.firstArtist);
  const otherArtists = mapSpotifyPathfinderArtists(track.otherArtists);
  const listArtists = mapSpotifyPathfinderArtists(track.artists);
  const artists = [...new Set([...(firstArtists.length ? firstArtists : listArtists), ...otherArtists])].filter(Boolean);
  const albumOfTrack = track.albumOfTrack && typeof track.albumOfTrack === "object"
    ? track.albumOfTrack as Record<string, unknown>
    : null;
  const albumArtists = mapSpotifyPathfinderArtists(albumOfTrack?.artists);
  const albumArtist = albumArtists.length ? albumArtists.join("; ") : null;
  const images = mapSpotifyPathfinderImages(albumOfTrack?.coverArt && typeof albumOfTrack.coverArt === "object"
    ? (albumOfTrack.coverArt as { sources?: unknown }).sources
    : undefined);
  const releaseDate = albumOfTrack?.date && typeof albumOfTrack.date === "object" && typeof (albumOfTrack.date as { isoString?: unknown }).isoString === "string"
    ? ((albumOfTrack.date as { isoString: string }).isoString.split("T")[0] || null)
    : null;
  const durationMs = typeof (track.duration as { totalMilliseconds?: unknown } | undefined)?.totalMilliseconds === "number"
    ? (track.duration as { totalMilliseconds: number }).totalMilliseconds
    : (typeof (track.trackDuration as { totalMilliseconds?: unknown } | undefined)?.totalMilliseconds === "number"
        ? (track.trackDuration as { totalMilliseconds: number }).totalMilliseconds
        : 0);
  const totalTracks = typeof (albumOfTrack?.tracks as { totalCount?: unknown } | undefined)?.totalCount === "number"
    ? (albumOfTrack?.tracks as { totalCount: number }).totalCount
    : null;
  const copyrightItems = Array.isArray((albumOfTrack?.copyright as { items?: unknown[] } | undefined)?.items)
    ? (albumOfTrack?.copyright as { items: Array<{ text?: string }> }).items
    : [];

  const title = typeof track.name === "string" ? normalizeSpotifyText(track.name) : "";
  if (!title || !artists.length) return null;

  return {
    name: title,
    artists,
    album_artists: albumArtists.length ? albumArtists : undefined,
    compilation: isCompilationAlbum(albumArtist),
    album: typeof albumOfTrack?.name === "string" ? normalizeSpotifyText(albumOfTrack.name) : title,
    image: pickLargestSpotifyImage(images),
    thumb_image: pickSmallestSpotifyImage(images),
    id: trackId,
    external_url: typeof (track.sharingInfo as { shareUrl?: unknown } | undefined)?.shareUrl === "string"
      ? (track.sharingInfo as { shareUrl: string }).shareUrl
      : `https://open.spotify.com/track/${trackId}`,
    duration_ms: durationMs,
    preview_url: null,
    explicit: typeof (track.contentRating as { label?: unknown } | undefined)?.label === "string"
      ? (track.contentRating as { label: string }).label === "EXPLICIT"
      : false,
    release_date: releaseDate,
    track_number: collectionType === "playlist"
      ? index + 1
      : (typeof track.trackNumber === "number" ? track.trackNumber : index + 1),
    disc_number: typeof track.discNumber === "number" ? track.discNumber : 1,
    total_tracks: totalTracks,
    copyright: copyrightItems[0]?.text || null,
  };
}

async function fetchSpotifyEmbedSession(
  type: "track" | "playlist" | "album" | "artist",
  id: string,
): Promise<SpotifyEmbedSession | null> {
  try {
    const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!nextDataMatch) return null;

    const nextData = JSON.parse(nextDataMatch[1]);
    const entity = nextData?.props?.pageProps?.state?.data?.entity;
    const accessToken = nextData?.props?.pageProps?.state?.settings?.session?.accessToken;

    return {
      accessToken: typeof accessToken === "string" ? accessToken : null,
      entity: entity && typeof entity === "object" ? entity as Record<string, unknown> : null,
    };
  } catch {
    return null;
  }
}

async function fetchSpotifyPathfinder<T>(
  accessToken: string,
  operationName: string,
  sha256Hash: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  try {
    const res = await fetch("https://api-partner.spotify.com/pathfinder/v1/query", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operationName,
        variables,
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash,
          },
        },
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data as T;
  } catch {
    return null;
  }
}

async function fetchSpotifyInternalCollectionData(
  type: "track" | "playlist" | "album" | "artist",
  id: string,
): Promise<SpotifyInternalCollectionData | null> {
  const session = await fetchSpotifyEmbedSession(type, id);
  if (!session?.accessToken) return null;

  if (type === "track") {
    const data = await fetchSpotifyPathfinder<{ data?: { trackUnion?: Record<string, unknown> } }>(
      session.accessToken,
      "getTrack",
      "612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294",
      { uri: `spotify:track:${id}` },
    );
    const trackUnion = data?.data?.trackUnion;
    if (!trackUnion) return null;

    const track = mapSpotifyPathfinderTrack(trackUnion, "track", 0);
    if (!track) return null;

    return {
      name: track.name,
      owner: track.artists.join(", "),
      images: track.image ? [track.image, ...(track.thumb_image ? [track.thumb_image] : [])] : [],
      totalTracks: 1,
      releaseDate: track.release_date,
      tracks: [track],
      entity: session.entity,
    };
  }

  if (type === "playlist") {
    let offset = 0;
    const limit = 100;
    let name = "Spotify";
    let owner = "";
    let images: SpotifyFromUrlImage[] = [];
    let totalTracks = 0;
    const tracks: SpotifyFromUrlTrack[] = [];

    while (true) {
      const data = await fetchSpotifyPathfinder<{ data?: { playlistV2?: Record<string, unknown> } }>(
        session.accessToken,
        "fetchPlaylist",
        "32b05e92e438438408674f95d0fdad8082865dc32acd55bd97f5113b8579092b",
        {
          uri: `spotify:playlist:${id}`,
          offset,
          limit,
          enableWatchFeedEntrypoint: false,
          includeEpisodeContentRatingsV2: false,
        },
      );
      const playlistV2 = data?.data?.playlistV2;
      if (!playlistV2) return tracks.length ? { name, owner, images, totalTracks: totalTracks || tracks.length, releaseDate: null, tracks, entity: session.entity } : null;

      if (offset === 0) {
        name = typeof playlistV2.name === "string" ? normalizeSpotifyText(playlistV2.name) : name;
        owner = typeof (playlistV2.ownerV2 as { data?: { name?: unknown } } | undefined)?.data?.name === "string"
          ? normalizeSpotifyText((playlistV2.ownerV2 as { data: { name: string } }).data.name)
          : owner;
        images = mapSpotifyPathfinderImages((playlistV2.images as { items?: { sources?: unknown }[] } | undefined)?.items?.[0]?.sources);
        totalTracks = typeof (playlistV2.content as { totalCount?: unknown } | undefined)?.totalCount === "number"
          ? (playlistV2.content as { totalCount: number }).totalCount
          : totalTracks;
      }

      const items = Array.isArray((playlistV2.content as { items?: unknown[] } | undefined)?.items)
        ? (playlistV2.content as { items: unknown[] }).items
        : [];
      for (const item of items) {
        const trackData = (item as { itemV2?: { data?: Record<string, unknown> } }).itemV2?.data;
        if (!trackData) continue;
        const mapped = mapSpotifyPathfinderTrack(trackData, "playlist", tracks.length);
        if (mapped) tracks.push(mapped);
      }

      if (!items.length || items.length < limit || tracks.length >= totalTracks) break;
      offset += items.length;
    }

    return tracks.length ? { name, owner, images, totalTracks: totalTracks || tracks.length, releaseDate: null, tracks, entity: session.entity } : null;
  }

  if (type === "album") {
    let offset = 0;
    const limit = 50;
    let name = "Spotify";
    let owner = "";
    let images: SpotifyFromUrlImage[] = [];
    let totalTracks = 0;
    let releaseDate: string | null = null;
    const tracks: SpotifyFromUrlTrack[] = [];

    while (true) {
      const data = await fetchSpotifyPathfinder<{ data?: { albumUnion?: Record<string, unknown> } }>(
        session.accessToken,
        "getAlbum",
        "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10",
        {
          uri: `spotify:album:${id}`,
          locale: "https://open.spotify.com/intl-en",
          offset,
          limit,
        },
      );
      const albumUnion = data?.data?.albumUnion;
      if (!albumUnion) return tracks.length ? { name, owner, images, totalTracks: totalTracks || tracks.length, releaseDate, tracks, entity: session.entity } : null;

      if (offset === 0) {
        name = typeof albumUnion.name === "string" ? normalizeSpotifyText(albumUnion.name) : name;
        owner = mapSpotifyPathfinderArtists(albumUnion.artists).join(", ");
        images = mapSpotifyPathfinderImages((albumUnion.coverArt as { sources?: unknown } | undefined)?.sources);
        totalTracks = typeof (albumUnion.tracksV2 as { totalCount?: unknown } | undefined)?.totalCount === "number"
          ? (albumUnion.tracksV2 as { totalCount: number }).totalCount
          : totalTracks;
        releaseDate = typeof (albumUnion.date as { isoString?: unknown } | undefined)?.isoString === "string"
          ? ((albumUnion.date as { isoString: string }).isoString.split("T")[0] || null)
          : null;
      }

      const items = Array.isArray((albumUnion.tracksV2 as { items?: unknown[] } | undefined)?.items)
        ? (albumUnion.tracksV2 as { items: unknown[] }).items
        : [];
      for (const item of items) {
        const trackData = (item as { track?: Record<string, unknown> }).track;
        if (!trackData) continue;
        const mapped = mapSpotifyPathfinderTrack(trackData, "album", tracks.length);
        if (mapped) tracks.push(mapped);
      }

      if (!items.length || items.length < limit || tracks.length >= totalTracks) break;
      offset += items.length;
    }

    return tracks.length ? { name, owner, images, totalTracks: totalTracks || tracks.length, releaseDate, tracks, entity: session.entity } : null;
  }

  const data = await fetchSpotifyPathfinder<{ data?: { artistUnion?: Record<string, unknown> } }>(
    session.accessToken,
    "queryArtistOverview",
    "5b9e64f43843fa3a9b6a98543600299b0a2cbbbccfdcdcef2402eb9c1017ca4c",
    {
      uri: `spotify:artist:${id}`,
      locale: "https://open.spotify.com/intl-en",
      preReleaseV2: false,
    },
  );
  const artistUnion = data?.data?.artistUnion;
  if (!artistUnion) return null;

  const name = typeof (artistUnion.profile as { name?: unknown } | undefined)?.name === "string"
    ? normalizeSpotifyText((artistUnion.profile as { name: string }).name)
    : "Spotify";
  const images = mapSpotifyPathfinderImages((artistUnion.visuals as { avatarImage?: { sources?: unknown } } | undefined)?.avatarImage?.sources);
  const items = Array.isArray((artistUnion.discography as { topTracks?: { items?: unknown[] } } | undefined)?.topTracks?.items)
    ? (artistUnion.discography as { topTracks: { items: unknown[] } }).topTracks.items
    : [];
  const tracks = items
    .map((item, index) => {
      const trackData = (item as { track?: Record<string, unknown> }).track;
      return trackData ? mapSpotifyPathfinderTrack(trackData, "artist", index) : null;
    })
    .filter((track): track is SpotifyFromUrlTrack => track !== null);

  return tracks.length ? { name, owner: name, images, totalTracks: tracks.length, releaseDate: null, tracks, entity: session.entity } : null;
}

async function fetchSpotifyEmbedEntity(type: "track" | "playlist" | "album" | "artist", id: string): Promise<Record<string, unknown> | null> {
  const session = await fetchSpotifyEmbedSession(type, id);
  return session?.entity || null;
}

async function fetchSpotifyEmbedHtml(type: "playlist" | "album" | "artist", id: string): Promise<string | null> {
  try {
    const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function mapSpotifyEmbedTrack(
  track: Record<string, unknown>,
  collectionType: "playlist" | "album" | "artist",
  collectionName: string,
  collectionImage: string,
  collectionReleaseDate: string | null,
  index: number,
): TrackInfo | null {
  const trackUri = typeof track.uri === "string" ? track.uri : "";
  const trackIdMatch = trackUri.match(/spotify:track:(.+)/);
  const trackId = trackIdMatch ? trackIdMatch[1] : null;
  if (!trackId) return null;

  const title = typeof track.title === "string" ? normalizeSpotifyText(track.title) : "";
  const artists = parseSpotifyArtists(track.subtitle);
  if (!title || !artists.length) return null;

  return {
    name: title,
    artist: artists.join("; "),
    albumArtist: collectionType === "album" || collectionType === "artist" ? artists.join("; ") : null,
    compilation: collectionType === "album" && isCompilationAlbum(artists.join("; ")),
    album: collectionType === "album" ? collectionName : "",
    albumArt: collectionType === "album" ? collectionImage : "",
    duration: formatDuration(typeof track.duration === "number" ? track.duration : 0),
    durationMs: typeof track.duration === "number" ? track.duration : 0,
    isrc: null,
    genre: null,
    releaseDate: collectionType === "album" ? collectionReleaseDate : null,
    spotifyUrl: `https://open.spotify.com/track/${trackId}`,
    explicit: Boolean(track.isExplicit),
    trackNumber: index + 1,
    discNumber: null,
    label: null,
    copyright: null,
    totalTracks: null,
  };
}

/**
 * Scrape album name from the regular Spotify track page's og:description.
 * Format: "Artist · Album · Song · Year"
 */
async function scrapeSpotifyAlbumName(trackId: string): Promise<string | null> {
  try {
    const meta = await fetchSpotifyPageMetadata("track", trackId);
    const albumName = getSpotifyAlbumNameFromDescription(meta?.ogDescription || meta?.description || null);
    if (albumName) {
      logEvent("resolve-track.scraped_album_name_from_og_description");
    }
    return albumName;
  } catch {
    return null;
  }
}

async function scrapeSpotifyTrack(url: string): Promise<TrackInfo | null> {
  const trackId = extractTrackId(url);
  if (!trackId) return null;

  try {
    const [entity, albumName] = await Promise.all([
      fetchSpotifyEmbedEntity("track", trackId),
      scrapeSpotifyAlbumName(trackId),
    ]);
    if (!entity || entity.type !== "track") return null;

    const name = typeof entity.title === "string" && entity.title.trim()
      ? entity.title.trim()
      : (typeof entity.name === "string" ? entity.name.trim() : "");

    const artist = Array.isArray(entity.artists)
      ? entity.artists
          .map((a: { name?: unknown }) => (typeof a?.name === "string" ? a.name.trim() : ""))
          .filter(Boolean)
          .join("; ")
      : "";

    if (!name || !artist) return null;

    const durationMs = typeof entity.duration === "number" ? entity.duration : 0;
    const releaseDate = getSpotifyEntityReleaseDate(entity);
    const albumArt = findSpotifyImageUrl(entity) || "";

    logEvent("resolve-track.fallback_scrape_from_spotify_embed");

    return {
      name,
      artist,
      albumArtist: artist,
      compilation: isCompilationAlbum(artist),
      album: albumName || name,
      albumArt,
      duration: formatDuration(durationMs),
      durationMs,
      isrc: null,
      genre: null,
      releaseDate,
      spotifyUrl: `https://open.spotify.com/track/${trackId}`,
      explicit: Boolean(entity.isExplicit),
      trackNumber: null,
      discNumber: null,
      label: null,
      copyright: null,
      totalTracks: null,
    };
  } catch {
    logEvent("resolve-track.spotify_embed_scrape_failed");
    return null;
  }
}

/** Parse "Artist - Title", "Title by Artist", or just "Title" */
function parseOembedTitle(raw: string): { artist: string | null; title: string } {
  const dashMatch = raw.match(/^(.+?)\s*[-–—]\s*(.+?)(?:\s*[\[(].*)?$/);
  if (dashMatch) return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() };
  const byMatch = raw.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) return { artist: byMatch[2].trim(), title: byMatch[1].trim() };
  return { artist: null, title: raw.trim() };
}

/** Score-based Deezer result picker */
function pickBestDeezerMatch(
  results: { id: number; title: string; artist: { name: string }; album?: { title: string } }[] | undefined,
  title: string,
  artist: string | null,
  album?: string | null,
): { id: number } | null {
  if (!results?.length) return null;
  const nt = normalize(title);
  const na = artist ? normalize(artist) : null;
  const nAlbum = album ? normalize(album) : null;
  let best = results[0];
  let bestScore = -1;
  for (const r of results) {
    let s = 0;
    const rt = normalize(r.title);
    const ra = normalize(r.artist.name);
    if (rt === nt) s += 3; else if (rt.includes(nt) || nt.includes(rt)) s += 1;
    if (na) { if (ra === na) s += 3; else if (ra.includes(na) || na.includes(ra)) s += 1; }
    // Album match is a strong disambiguator for same-name tracks
    if (nAlbum && r.album?.title) {
      const rAlbum = normalize(r.album.title);
      if (rAlbum === nAlbum) s += 4;
      else if (rAlbum.includes(nAlbum) || nAlbum.includes(rAlbum)) s += 2;
    }
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * Try Spotify Web API (client credentials).
 * NOTE: Spotify now requires premium for track lookups.
 * We cache the 403 status to avoid wasting time on every request.
 */
let spotifyApiBroken = false;
let spotifyApiLastCheck = 0;
const SPOTIFY_API_RECHECK_MS = 30 * 60 * 1000; // re-check every 30 min

async function trySpotifyApi(url: string): Promise<TrackInfo | null> {
  // Skip entirely if we know Spotify API is 403
  if (spotifyApiBroken && Date.now() - spotifyApiLastCheck < SPOTIFY_API_RECHECK_MS) {
    return null;
  }

  try {
    const result = await withLimit(() => getTrackInfo(url));
    spotifyApiBroken = false; // it worked!
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("403")) {
      spotifyApiBroken = true;
      spotifyApiLastCheck = Date.now();
      logEvent("resolve-track.spotify_api_requires_premium_skipping_for_30min");
    } else {
      logEvent("resolve-track.spotify_api_failed");
    }
    return null;
  }
}

/** oEmbed → parsed artist + title. If no artist from oEmbed, scrape embed page. */
async function resolveOembed(url: string): Promise<{ artist: string | null; title: string } | null> {
  let result: { artist: string | null; title: string } | null = null;

  // Step 1: Try oEmbed API
  result = await withLimit(async () => {
    for (const base of ["https://embed.spotify.com/oembed/", "https://open.spotify.com/oembed"]) {
      try {
        const res = await fetch(`${base}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const o = await res.json();
          const raw = o.title || o.html?.match(/title="Spotify Embed: ([^"]+)"/)?.[1];
          if (raw) {
            const parsed = parseOembedTitle(raw);
            logEvent("resolve-track.parsed");
            return parsed;
          }
        }
      } catch { /* next */ }
    }
    return null;
  });

  // Step 2: If we got a title but no artist, scrape the embed page for artist info
  // The embed page contains inline JSON with full track metadata including artists array
  if (result && !result.artist) {
    const trackId = extractTrackId(url);
    if (trackId) {
      try {
        const embedRes = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
          signal: AbortSignal.timeout(5000),
          headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
        });
        if (embedRes.ok) {
          const html = await embedRes.text();

          // Primary: parse __NEXT_DATA__ JSON payload from embed page
          const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
          if (nextDataMatch) {
            try {
              const nextData = JSON.parse(nextDataMatch[1]);
              const entity = nextData?.props?.pageProps?.state?.data?.entity;
              if (entity) {
                const names = Array.isArray(entity.artists)
                  ? entity.artists
                      .map((a: { name?: unknown }) => (typeof a?.name === "string" ? a.name.trim() : ""))
                      .filter(Boolean)
                  : [];

                if (names.length > 0) {
                  result.artist = names.join("; ");
                  logEvent("resolve-track.scraped_artist_from_next_data");
                }

                const entityTitle = typeof entity.title === "string" && entity.title.trim()
                  ? entity.title.trim()
                  : (typeof entity.name === "string" ? entity.name.trim() : "");

                if (entityTitle) {
                  result.title = entityTitle;
                }
              }
            } catch {
              // Continue to regex fallback
            }
          }

          // Fallback: parse inline JSON with "artists":[{"name":"..."}]
          const jsonMatch = html.match(/"artists"\s*:\s*\[(\{[^\]]+)\]/);
          if (!result.artist && jsonMatch) {
            try {
              const artists = JSON.parse(`[${jsonMatch[1]}]`);
              const names = artists
                .map((a: { name?: string }) => a.name)
                .filter(Boolean);
              if (names.length > 0) {
                result.artist = names.join("; ");
                logEvent("resolve-track.scraped_artist_from_embed_json");
              }
            } catch { /* JSON parse failed */ }
          }

          // Fallback: og:title "TITLE - song and lyrics by ARTIST | Spotify"
          if (!result.artist) {
            const titleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)
              || html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:title"/i);
            if (titleMatch) {
              const byMatch = titleMatch[1].match(/(?:song and lyrics by|by)\s+(.+?)(?:\s*\||\s*$)/i);
              if (byMatch) {
                result.artist = byMatch[1].trim();
                logEvent("resolve-track.scraped_artist_from_og_title");
              }
            }
          }
        }
      } catch {
        // scraping failed, continue without artist
      }
    }
  }

  return result;
}

/**
 * Search MusicBrainz by title + artist → get ISRC → look up Deezer by ISRC.
 * MusicBrainz is free, no auth, excellent metadata. Rate limit: 1 req/s with User-Agent.
 */
async function searchMusicBrainz(title: string, artist: string | null): Promise<TrackInfo | null> {
  try {
    const q = artist
      ? `recording:"${title}" AND artist:"${artist}"`
      : `recording:"${title}"`;
    const res = await fetch(
      `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=3`,
      {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Yoink/1.0 (music downloader)" },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const recordings = data.recordings;
    if (!recordings?.length) return null;

    // Find best match with an ISRC
    for (const rec of recordings) {
      const isrcs: string[] = rec.isrcs || [];
      if (isrcs.length === 0) continue;

      // Try each ISRC on Deezer (fast, free, no auth)
      for (const isrc of isrcs) {
        const deezerId = await lookupDeezerByIsrc(isrc);
        if (deezerId) {
          const meta = await fetchDeezerTrackMetadata(deezerId);
          if (meta) {
            logEvent("resolve-track.musicbrainz_isrc_deezer");
            return { ...meta, spotifyUrl: "", label: null, copyright: null } as TrackInfo;
          }
        }
      }

      // If no Deezer match via ISRC, build TrackInfo from MusicBrainz data + iTunes
      const mbArtist = rec["artist-credit"]?.[0]?.name || artist || "Unknown";
      const mbTitle = rec.title || title;
      const itunesResult = await searchItunesTrack(mbArtist, mbTitle);
      if (itunesResult) {
        // Attach ISRC from MusicBrainz if iTunes didn't have one
        if (!itunesResult.isrc && isrcs[0]) itunesResult.isrc = isrcs[0];
        logEvent("resolve-track.musicbrainz_itunes");
        return itunesResult;
      }
    }
  } catch {
    logEvent("resolve-track.musicbrainz_failed");
  }
  return null;
}

/** Search Deezer with structured artist/title query + scoring. */
export async function searchDeezerStructured(title: string, artist: string | null, album?: string | null): Promise<TrackInfo | null> {
  try {
    let q = artist ? `artist:"${artist}" track:"${title}"` : title;
    // Include album in query when available to help Deezer return the right version
    if (album) q += ` album:"${album}"`;
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let match = pickBestDeezerMatch(data.data, title, artist, album);

    // If album query returned no results, retry without album constraint
    if (!match && album) {
      const fallbackQ = artist ? `artist:"${artist}" track:"${title}"` : title;
      const fallbackRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(fallbackQ)}&limit=10`, {
        signal: AbortSignal.timeout(8000),
      });
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        match = pickBestDeezerMatch(fallbackData.data, title, artist, album);
      }
    }

    if (match) {
      const meta = await fetchDeezerTrackMetadata(String(match.id));
      if (meta) {
        logEvent("resolve-track.deezer_search");
        return { ...meta, spotifyUrl: "", label: null, copyright: null } as TrackInfo;
      }
    }
  } catch { /* continue */ }
  return null;
}

// ---------------------------------------------------------------------------
// Public resolvers
// ---------------------------------------------------------------------------

/** Resolve a Spotify track URL → full TrackInfo. */
export async function resolveSpotifyTrack(url: string): Promise<TrackInfo | null> {
  // 1. Spotify API (client credentials) — best source, gives ISRC
  const spotify = await trySpotifyApi(url);
  if (spotify) return spotify;

  // 2. Song.link → Deezer ID (ID-based, no name confusion)
  try {
    const resolved = await resolveToSpotify(url);
    if (resolved?.deezerId) {
      const dz = await fetchDeezerTrackMetadata(resolved.deezerId);
      if (dz) {
        logEvent("resolve-track.deezer_via_song_link");
        return { ...dz, spotifyUrl: url, label: null, copyright: null } as TrackInfo;
      }
    }
  } catch { /* continue */ }

  // 3. Scrape Spotify embed + regular page to get album context for disambiguation.
  //    The embed has title/artist/duration, the regular page's og:description has album name.
  const scraped = await scrapeSpotifyTrack(url);

  // Use scraped album context for disambiguation in name-based searches
  const albumContext = scraped?.album && scraped.album !== scraped.name ? scraped.album : null;

  // 4. oEmbed → structured search (with album context from scrape)
  const oembed = await resolveOembed(url);
  if (oembed) {
    const { artist, title } = oembed;
    // Prefer album from scrape, which is more reliable
    const album = albumContext;

    if (artist) {
      const dz = await searchDeezerStructured(title, artist, album);
      if (dz) { dz.spotifyUrl = url; return dz; }

      const mb = await searchMusicBrainz(title, artist);
      if (mb) { mb.spotifyUrl = url; return mb; }
    } else {
      const dz = await searchDeezerStructured(title, null, album);
      if (dz) { dz.spotifyUrl = url; return dz; }
    }

    try {
      const itunes = await searchItunesTrack(artist || "", title, album);
      if (itunes) {
        logEvent("resolve-track.itunes_search");
        return { ...itunes, spotifyUrl: url };
      }
    } catch { /* continue */ }
  }

  // 5. Return scraped embed data if we have it (better than nothing)
  if (scraped) {
    logEvent("resolve-track.using_scraped_embed_data_as_final_fallback");
    return scraped;
  }

  logEvent("resolve-track.all_sources_exhausted_for_spotify_url");
  return null;
}

/** Resolve an Apple Music URL → full TrackInfo. */
export async function resolveAppleMusicTrack(url: string): Promise<TrackInfo | null> {
  // 1. Direct iTunes lookup by ID (fast, reliable, no rate limit)
  const itunesId = extractAppleMusicTrackId(url);
  if (itunesId) {
    logEvent("resolve-track.itunes_lookup_id");
    const track = await lookupByItunesId(itunesId);
    if (track) {
      if (!track.isrc) {
        try {
          const deezer = await searchDeezerStructured(track.name, track.artist, track.album || null);
          if (deezer) {
            track.isrc = track.isrc || deezer.isrc;
            track.releaseDate = track.releaseDate || deezer.releaseDate;
            track.albumArtist = track.albumArtist || deezer.albumArtist;
            track.totalTracks = track.totalTracks ?? deezer.totalTracks;
          }
        } catch {
          // Keep the iTunes result if Deezer enrichment fails.
        }
      }

      logEvent("resolve-track.itunes_lookup");
      return track;
    }
  }

  // 2. Song.link → Deezer or Spotify
  const resolved = await resolveToSpotify(url);
  if (resolved?.deezerId) {
    const dz = await fetchDeezerTrackMetadata(resolved.deezerId);
    if (dz) {
      logEvent("resolve-track.apple_music_deezer_via_song_link");
      return { ...dz, spotifyUrl: resolved.spotifyUrl || "", label: null, copyright: null } as TrackInfo;
    }
  }
  if (resolved?.spotifyUrl) {
    const spotify = await trySpotifyApi(resolved.spotifyUrl);
    if (spotify) return spotify;
  }

  return null;
}

/** Resolve a YouTube URL → full TrackInfo (always returns something). */
export async function resolveYouTubeTrack(videoId: string, url: string): Promise<TrackInfo> {
  const ytInfo = await getYouTubeTrackInfo(videoId);

  // Try cross-platform enrichment via Song.link
  const resolved = await resolveToSpotify(url);
  if (resolved?.deezerId) {
    const dz = await fetchDeezerTrackMetadata(resolved.deezerId);
    if (dz) {
      logEvent("resolve-track.youtube_enriched_via_deezer");
      return { ...dz, spotifyUrl: resolved.spotifyUrl || "", label: null, copyright: null } as TrackInfo;
    }
  }
  if (resolved?.spotifyUrl) {
    const spotify = await trySpotifyApi(resolved.spotifyUrl);
    if (spotify) return spotify;
  }

  // Enrich via Deezer/MusicBrainz/iTunes search using parsed YouTube title + artist
  if (ytInfo.artist && ytInfo.artist !== "Unknown Artist") {
    const dz = await searchDeezerStructured(ytInfo.name, ytInfo.artist);
    if (dz) return dz;

    const mb = await searchMusicBrainz(ytInfo.name, ytInfo.artist);
    if (mb) return mb;

    try {
      const itunes = await searchItunesTrack(ytInfo.artist, ytInfo.name);
      if (itunes) {
        logEvent("resolve-track.youtube_enriched_via_itunes");
        return itunes;
      }
    } catch { /* continue */ }
  }

  return ytInfo;
}

// ---------------------------------------------------------------------------
// Playlist/Album scraping from Spotify embed pages (no API key needed)
// ---------------------------------------------------------------------------

/**
 * Scrape track list from a Spotify embed page (playlist or album).
 * The embed page contains inline JSON with title, subtitle (artist),
 * duration, uri, and explicit flag for each track.
 */
async function scrapeSpotifyEmbed(type: "playlist" | "album" | "artist", id: string): Promise<PlaylistInfo | null> {
  try {
    const tracks: TrackInfo[] = [];
    let name = "Unknown";
    let image = "";
    let releaseDate: string | null = null;

    const entity = await fetchSpotifyEmbedEntity(type, id);
    if (entity) {
      name = typeof entity.name === "string" ? entity.name : name;
      image = findSpotifyImageUrl(entity) || "";
      releaseDate = getSpotifyEntityReleaseDate(entity);

      const trackList = Array.isArray(entity.trackList) ? entity.trackList : Array.isArray(entity.tracks) ? entity.tracks : [];
      for (let i = 0; i < trackList.length; i++) {
        const mapped = mapSpotifyEmbedTrack(
          trackList[i] as Record<string, unknown>,
          type,
          name,
          image,
          releaseDate,
          i,
        );
        if (mapped) tracks.push(mapped);
      }
    }

    if (tracks.length === 0) {
      const html = await fetchSpotifyEmbedHtml(type, id);
      if (!html) return null;

      const nameMatch = html.match(/"name":"([^"]+?)","uri":"spotify:(?:playlist|album|artist):/);
      name = nameMatch ? nameMatch[1] : name;

      const trackPattern = /"uri":"spotify:track:([^"]+)","uid":"[^"]*","title":"([^"]*)","subtitle":"([^"]*)","isExplicit":(true|false),"isNineteenPlus":[^,]*,"duration":(\d+)/g;
      let match: RegExpExecArray | null;
      while ((match = trackPattern.exec(html)) !== null) {
        const [, trackId, title, artist, explicit, durationStr] = match;
        const durationMs = parseInt(durationStr, 10);
        tracks.push({
          name: title,
          artist: normalizeSpotifyText(artist),
          albumArtist: type === "album" ? normalizeSpotifyText(artist) : null,
          compilation: type === "album" && isCompilationAlbum(artist),
          album: type === "album" ? name : "",
          albumArt: type === "album" ? image : "",
          duration: formatDuration(durationMs),
          durationMs,
          isrc: null,
          genre: null,
          releaseDate: type === "album" ? releaseDate : null,
          spotifyUrl: `https://open.spotify.com/track/${trackId}`,
          explicit: explicit === "true",
          trackNumber: tracks.length + 1,
          discNumber: null,
          label: null,
          copyright: null,
          totalTracks: null,
        });
      }

      if (!image) {
        const artMatch = html.match(/"coverArt":\{"extractedColors"[^}]*\},"sources":\[\{"url":"([^"]+)"/);
        image = artMatch ? artMatch[1] : "";
      }
    }

    if (tracks.length === 0) return null;

    logEvent("resolve-track.scraped_tracks_from_embed");
    return { name, image, tracks };
  } catch {
    logEvent("resolve-track.embed_scrape_failed_for");
    return null;
  }
}

/** Resolve a Spotify playlist URL via embed scraping. */
export async function resolvePlaylist(url: string): Promise<PlaylistInfo | null> {
  const id = extractPlaylistId(url);
  if (!id) return null;
  return scrapeSpotifyEmbed("playlist", id);
}

/** Resolve a Spotify album URL via embed scraping. */
export async function resolveAlbum(url: string): Promise<PlaylistInfo | null> {
  const id = extractAlbumId(url);
  if (!id) return null;
  return scrapeSpotifyEmbed("album", id);
}

/** Resolve a Spotify artist URL via embed scraping. */
export async function resolveArtist(url: string): Promise<PlaylistInfo | null> {
  const id = extractArtistId(url);
  if (!id) return null;
  return scrapeSpotifyEmbed("artist", id);
}

export async function getSpotifyFromUrl(url: string, options?: SpotifyFromUrlOptions): Promise<SpotifyFromUrlResponse | null> {
  const enrichIsrc = options?.enrichIsrc ?? false;
  const urlType = extractTrackId(url)
    ? "track"
    : extractPlaylistId(url)
    ? "playlist"
    : extractAlbumId(url)
    ? "album"
    : extractArtistId(url)
    ? "artist"
    : null;

  if (!urlType) return null;

  if (urlType === "track") {
    const trackId = extractTrackId(url);
    if (!trackId) return null;

    const [internal, meta] = await Promise.all([
      fetchSpotifyInternalCollectionData("track", trackId),
      fetchSpotifyPageMetadata("track", trackId),
    ]);
    const rawTrack = internal?.tracks[0] || await getSpotifyTrackPayload(trackId);
    if (!rawTrack) return null;

    const track = enrichIsrc ? await enrichTrackWithIsrc(rawTrack) : rawTrack;

    const images = internal?.images?.length
      ? internal.images
      : track.image
      ? [track.image, ...(track.thumb_image ? [track.thumb_image] : [])]
      : getSpotifyImageFallback(meta);

    return {
      playlist_info: {
        id: trackId,
        type: "track",
        name: internal?.name || track.name,
        description: "",
        owner: internal?.owner || track.artists.join(", "),
        total_tracks: 1,
        external_url: url,
        images,
        release_date: internal?.releaseDate || track.release_date,
        from_source: "yoink",
      },
      tracks: [track],
    };
  }

  const id = urlType === "playlist"
    ? extractPlaylistId(url)
    : urlType === "album"
    ? extractAlbumId(url)
    : extractArtistId(url);
  if (!id) return null;

  const [internal, meta] = await Promise.all([
    fetchSpotifyInternalCollectionData(urlType, id),
    fetchSpotifyPageMetadata(urlType, id),
  ]);
  let entity = internal?.entity || null;
  if (!internal && !entity) {
    entity = await fetchSpotifyEmbedEntity(urlType, id);
    if (!entity) return null;
  }

  const collectionName = internal?.name || (entity && typeof entity.name === "string" ? normalizeSpotifyText(entity.name) : "Spotify");
  const embedImages = entity ? extractSpotifyImages(entity) : [];
  const collectionImages = internal?.images?.length
    ? internal.images
    : embedImages.length
    ? embedImages
    : getSpotifyImageFallback(meta);
  const collectionReleaseDate = internal?.releaseDate || (entity ? getSpotifyEntityReleaseDate(entity) : null) || meta?.musicReleaseDate || null;
  const trackList = internal?.tracks || (entity ? (Array.isArray(entity.trackList) ? entity.trackList : Array.isArray(entity.tracks) ? entity.tracks : []) : []);
  const collectionMeta = parseSpotifyCollectionMetadata(urlType, meta?.ogDescription || meta?.description || null);

  const tracks: SpotifyFromUrlTrack[] = [];
  for (let batchStart = 0; batchStart < trackList.length; batchStart += 5) {
    const batch = trackList.slice(batchStart, batchStart + 5);
    const resolved = await Promise.all(
      batch.map(async (track, offset) => {
        const index = batchStart + offset;

        if (internal) {
          const baseTrack = track as SpotifyFromUrlTrack;
          if (!enrichIsrc) return baseTrack;
          const hydrated = (await getSpotifyTrackPayload(baseTrack.id, baseTrack)) || baseTrack;
          return enrichIsrc ? enrichTrackWithIsrc(hydrated) : hydrated;
        }

        const item = track as Record<string, unknown>;
        const trackUri = typeof item.uri === "string" ? item.uri : "";
        const trackIdMatch = trackUri.match(/spotify:track:(.+)/);
        const trackId = trackIdMatch ? trackIdMatch[1] : "";
        const artists = parseSpotifyArtists(item.subtitle);
        if (!trackId || !artists.length || typeof item.title !== "string") return null;

        const fallback: SpotifyFromUrlTrack = {
          name: normalizeSpotifyText(item.title),
          artists,
          album: urlType === "album" ? collectionName : "",
          image: urlType === "album" ? pickLargestSpotifyImage(collectionImages) : null,
          thumb_image: urlType === "album" ? pickSmallestSpotifyImage(collectionImages) : null,
          id: trackId,
          external_url: `https://open.spotify.com/track/${trackId}`,
          duration_ms: typeof item.duration === "number" ? item.duration : 0,
          preview_url: typeof (item.audioPreview as { url?: unknown } | undefined)?.url === "string"
            ? (item.audioPreview as { url: string }).url
            : null,
          explicit: Boolean(item.isExplicit),
          release_date: urlType === "album" ? collectionReleaseDate : null,
          track_number: index + 1,
          disc_number: 1,
        };

        const baseTrack = (await getSpotifyTrackPayload(trackId, fallback)) || fallback;
        return enrichIsrc ? enrichTrackWithIsrc(baseTrack) : baseTrack;
      })
    );

    tracks.push(...resolved.filter((track): track is SpotifyFromUrlTrack => track !== null));
  }

  if (!tracks.length) return null;

  return {
    playlist_info: {
        id,
        type: urlType,
        name: collectionName,
        description: "",
        owner: internal?.owner || (urlType === "artist"
          ? collectionName
          : (entity && typeof entity.subtitle === "string" ? normalizeSpotifyText(entity.subtitle) : (collectionMeta.owner || ""))),
        total_tracks: internal?.totalTracks || meta?.musicSongCount || tracks.length,
        external_url: url,
        images: collectionImages,
        release_date: collectionReleaseDate,
      from_source: "yoink",
    },
    tracks,
  };
}

// ---------------------------------------------------------------------------
// Main resolvers
// ---------------------------------------------------------------------------

/** Main resolver — detects platform and dispatches to the right chain. */
export async function resolveTrack(url: string): Promise<{ track: TrackInfo; platform: string; youtubeVideoId?: string } | null> {
  const platform = detectPlatform(url);
  if (!platform) return null;

  let track: TrackInfo | null = null;
  let youtubeVideoId: string | undefined;

  if (platform === "apple-music") {
    track = await resolveAppleMusicTrack(url);
  } else if (platform === "youtube") {
    const vid = extractYouTubeId(url);
    if (!vid) return null;
    youtubeVideoId = vid;
    track = await resolveYouTubeTrack(vid, url);
  } else {
    // Prefer unfurl pipeline — uses Spotify internal endpoints, no API key / rate limit issues
    const unfurled = await getSpotifyFromUrl(url, { enrichIsrc: true });
    if (unfurled?.tracks[0]) {
      const t = unfurled.tracks[0];
      const artist = t.artists.join("; ");
      const albumArtist = t.album_artists?.length ? t.album_artists.join("; ") : null;
      track = {
        name: t.name,
        artist,
        albumArtist,
        compilation: t.compilation ?? isCompilationAlbum(albumArtist),
        album: t.album,
        albumArt: t.image?.url || t.thumb_image?.url || "",
        duration: `${Math.floor(t.duration_ms / 60000)}:${Math.floor((t.duration_ms % 60000) / 1000).toString().padStart(2, "0")}`,
        durationMs: t.duration_ms,
        isrc: t.external_ids?.isrc || null,
        genre: null,
        releaseDate: t.release_date || null,
        spotifyUrl: t.external_url || url,
        explicit: t.explicit,
        trackNumber: t.track_number,
        discNumber: t.disc_number,
        totalTracks: t.total_tracks ?? null,
        label: null,
        copyright: t.copyright || null,
      };
    }
    // Fall back to old resolve chain if unfurl fails
    if (!track) {
      track = await resolveSpotifyTrack(url);
    }
  }

  if (!track) return null;
  track.compilation = track.compilation ?? isCompilationAlbum(track.albumArtist);
  return { track, platform, youtubeVideoId };
}
