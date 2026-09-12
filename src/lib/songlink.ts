import { logEvent } from "@/lib/logger";
import { rateLimit } from "./ratelimit";

interface SonglinkResult {
  deezerId: string | null;
  tidalId: string | null;
}

interface SonglinkResolveResult {
  spotifyUrl: string | null;
  deezerId: string | null;
}

// Resolve any music URL to a Spotify URL via Song.link
export async function resolveToSpotify(
  url: string
): Promise<SonglinkResolveResult | null> {
  if (process.env.SONGLINK_ENABLED !== "true") return null;

  const { allowed } = rateLimit("songlink:global", 8, 60_000);
  if (!allowed) return null;

  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (lastRequestTime > 0 && timeSinceLast < 7000) {
    await new Promise((resolve) => setTimeout(resolve, 7000 - timeSinceLast));
  }

  try {
    lastRequestTime = Date.now();

    const res = await fetch(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&userCountry=US`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!res.ok) return null;

    const data = await res.json();

    let spotifyUrl: string | null = null;
    const spotifyEntity = data.linksByPlatform?.spotify;
    if (spotifyEntity?.url) {
      spotifyUrl = spotifyEntity.url;
    }

    let deezerId: string | null = null;
    const deezerEntity = data.linksByPlatform?.deezer;
    if (deezerEntity?.entityUniqueId) {
      const deezerData = data.entitiesByUniqueId?.[deezerEntity.entityUniqueId];
      if (deezerData?.id) {
        deezerId = String(deezerData.id);
      }
    }

    return { spotifyUrl, deezerId };
  } catch {
    return null;
  }
}

// In-memory cache with 1-hour TTL (max 500 entries)
const SONGLINK_CACHE_MAX = 500;
const cache = new Map<string, { result: SonglinkResult; expiresAt: number }>();

// Minimum gap between requests (7s)
let lastRequestTime = 0;

export async function resolveSonglink(
  spotifyUrl: string
): Promise<SonglinkResult | null> {
  if (process.env.SONGLINK_ENABLED !== "true") {
    logEvent("songlink.disabled_songlink_enabled");
    return null;
  }

  // Check cache
  const cached = cache.get(spotifyUrl);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  // Rate limit: 8 requests per 60s
  const { allowed } = rateLimit("songlink:global", 8, 60_000);
  if (!allowed) return null;

  // Enforce minimum 7s gap between calls
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (lastRequestTime > 0 && timeSinceLast < 7000) {
    await new Promise((resolve) => setTimeout(resolve, 7000 - timeSinceLast));
  }

  try {
    lastRequestTime = Date.now();

    const res = await fetch(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}&userCountry=US`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!res.ok) {
      logEvent("songlink.api_error", res.status);
      return null;
    }

    const data = await res.json();

    let deezerId: string | null = null;
    let tidalId: string | null = null;

    // Extract Deezer ID
    const deezerEntity = data.linksByPlatform?.deezer;
    if (deezerEntity?.entityUniqueId) {
      const deezerData = data.entitiesByUniqueId?.[deezerEntity.entityUniqueId];
      if (deezerData?.id) {
        deezerId = String(deezerData.id);
      }
    }

    // Extract Tidal ID (for Phase 2)
    const tidalEntity = data.linksByPlatform?.tidal;
    if (tidalEntity?.entityUniqueId) {
      const tidalData = data.entitiesByUniqueId?.[tidalEntity.entityUniqueId];
      if (tidalData?.id) {
        tidalId = String(tidalData.id);
      }
    }

    const result: SonglinkResult = { deezerId, tidalId };

    // Evict oldest entry if at capacity
    if (cache.size >= SONGLINK_CACHE_MAX) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }

    // Cache for 1 hour
    cache.set(spotifyUrl, {
      result,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    return result;
  } catch {
    return null;
  }
}
