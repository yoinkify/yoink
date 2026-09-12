import { logEvent } from "@/lib/logger";
import {
  detectUrlType,
  getAlbumInfo,
  getArtistTopTracks,
  getPlaylistInfo,
  type PlaylistInfo,
  type TrackInfo,
} from "./spotify";
import {
  resolveAlbum,
  resolveArtist,
  resolvePlaylist,
  resolveSpotifyTrack,
  searchDeezerStructured,
} from "./resolve-track";

export async function loadPlaylistWithFallback(url: string): Promise<PlaylistInfo | null> {
  const urlType = detectUrlType(url);

  if (urlType === "album") {
    try {
      return await getAlbumInfo(url);
    } catch {
      logEvent("playlist-workflow.album_api_failed");
      return resolveAlbum(url);
    }
  }

  if (urlType === "artist") {
    try {
      return await getArtistTopTracks(url);
    } catch {
      logEvent("playlist-workflow.artist_api_failed");
      return resolveArtist(url);
    }
  }

  try {
    return await getPlaylistInfo(url);
  } catch {
    logEvent("playlist-workflow.playlist_api_failed");
    return resolvePlaylist(url);
  }
}

export async function enrichPlaylistTracks(tracks: TrackInfo[]): Promise<TrackInfo[]> {
  const needsEnrichment = tracks.some((track) => !track.isrc && !track.albumArt);
  if (!needsEnrichment) return tracks;

  logEvent("playlist-workflow.enriching");

  return Promise.all(
    tracks.map(async (track) => {
      if (track.isrc && track.albumArt) return track;

      try {
        if (track.spotifyUrl) {
          const resolved = await resolveSpotifyTrack(track.spotifyUrl);
          if (resolved) return { ...resolved, spotifyUrl: track.spotifyUrl };
        }

        const deezerTrack = await searchDeezerStructured(track.name, track.artist, track.album || null);
        if (deezerTrack) return { ...deezerTrack, spotifyUrl: track.spotifyUrl };
      } catch {
        // Keep the original scraped track when enrichment fails.
      }

      return track;
    })
  );
}
