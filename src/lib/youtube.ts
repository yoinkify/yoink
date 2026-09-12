import { logEvent } from "@/lib/logger";
import { execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import type { TrackInfo } from "./spotify";

const execFileAsync = promisify(execFile);
const YT_DLP = process.env.YT_DLP_PATH || "yt-dlp";

const PIPED_INSTANCES = process.env.PIPED_API_URL
  ? [process.env.PIPED_API_URL]
  : [
      "https://api.piped.private.coffee",
    ];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface SearchOptions {
  artist?: string;
  title?: string;
  album?: string;
  durationMs?: number;
}

// Minimum score to accept a YouTube match (must have at least title + duration or artist match)
const MIN_SCORE = 5;

interface ScoredResult {
  url: string;
  title: string;
  uploaderName: string;
  duration: number;
  score: number;
}

function scoreResults(
  streams: { url: string; title: string; uploaderName: string; duration: number }[],
  match: SearchOptions
): ScoredResult[] {
  const normTitle = match.title ? normalize(match.title) : null;
  const normArtist = match.artist ? normalize(match.artist) : null;
  const targetDurationS = match.durationMs ? match.durationMs / 1000 : null;

  return streams.map((video) => {
    let score = 0;
    const vidTitle = normalize(video.title);
    const vidUploader = normalize(video.uploaderName || "");

    // Title contains the track name
    if (normTitle && vidTitle.includes(normTitle)) score += 3;

    // Uploader or video title contains artist name
    if (normArtist) {
      if (vidUploader.includes(normArtist)) score += 3;
      else if (vidTitle.includes(normArtist)) score += 2;
    }

    // Duration matching
    if (targetDurationS && video.duration > 0) {
      const diff = Math.abs(video.duration - targetDurationS);
      if (diff <= 2) score += 4;
      else if (diff <= 5) score += 2;
      else if (diff > 15) score -= 3;
    }

    return { ...video, score };
  }).sort((a, b) => b.score - a.score);
}

async function pipedSearch(query: string, apiUrl: string): Promise<{ url: string; title: string; uploaderName: string; duration: number }[]> {
  const res = await fetch(
    `${apiUrl}/search?q=${encodeURIComponent(query)}&filter=music_songs`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const items = data.items || [];
  return items.filter(
    (item: { type: string }) => item.type === "stream"
  ) as { url: string; title: string; uploaderName: string; duration: number }[];
}

async function ytdlpSearch(query: string): Promise<{ url: string; title: string; uploaderName: string; duration: number }[]> {
  try {
    const { stdout } = await execFileAsync(YT_DLP, [
      `ytsearch5:${query}`,
      "--dump-json",
      "--no-download",
      "--flat-playlist",
      "--no-warnings",
    ], { timeout: 20000 });

    const results: { url: string; title: string; uploaderName: string; duration: number }[] = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      try {
        const data = JSON.parse(line);
        if (data.id) {
          results.push({
            url: `/watch?v=${data.id}`,
            title: data.title || "",
            uploaderName: data.uploader || data.channel || "",
            duration: data.duration || 0,
          });
        }
      } catch {}
    }
    if (results.length > 0) logEvent("youtube.yt_dlp_search_returned");
    return results;
  } catch {
    logEvent("youtube.yt_dlp_search_failed");
    return [];
  }
}

async function youtubeSearch(query: string): Promise<{ url: string; title: string; uploaderName: string; duration: number }[]> {
  // Try piped first (faster, no subprocess)
  for (const instance of PIPED_INSTANCES) {
    logEvent("youtube.trying_piped_instance");
    const results = await pipedSearch(query, instance);
    if (results.length > 0) return results;
  }

  // Fall back to yt-dlp
  logEvent("youtube.piped_failed_trying_yt_dlp");
  return ytdlpSearch(query);
}

export async function searchYouTube(query: string, match?: SearchOptions): Promise<string | null> {
  try {
    const streams = await youtubeSearch(query);
    if (streams.length === 0) return null;

    // No match criteria — return first result (legacy behavior)
    if (!match) {
      return streams[0].url.replace("/watch?v=", "");
    }

    const scored = scoreResults(streams, match);
    const best = scored[0];

    logEvent("youtube.search");

    // If score is good enough, use it
    if (best.score >= MIN_SCORE) {
      return best.url.replace("/watch?v=", "");
    }

    // Try a more specific search with album name
    if (match.album) {
      logEvent("youtube.score_too_low_retrying_with_album");
      const refinedQuery = `${match.artist} - ${match.title} ${match.album}`;
      const refinedStreams = await youtubeSearch(refinedQuery);
      if (refinedStreams.length > 0) {
        const refinedScored = scoreResults(refinedStreams, match);
        const refinedBest = refinedScored[0];
        logEvent("youtube.refined_result");
        if (refinedBest.score >= MIN_SCORE) {
          return refinedBest.url.replace("/watch?v=", "");
        }
        // Use the better of the two even if below threshold
        if (refinedBest.score > best.score) {
          logEvent("youtube.using_refined_result_best_available");
          return refinedBest.url.replace("/watch?v=", "");
        }
      }
    }

    // Last resort: if nothing scored well, reject rather than serve the wrong song
    if (best.score < 2) {
      logEvent("youtube.no_good_match_found_rejecting_all_results");
      return null;
    }

    logEvent("youtube.using_best_available_match_below_ideal_threshold");
    return best.url.replace("/watch?v=", "");
  } catch {
    return null;
  }
}

async function pipedStreamUrl(videoId: string, apiUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/streams/${videoId}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const audioStreams: { url: string; mimeType: string; bitrate: number }[] =
      data.audioStreams || [];
    if (audioStreams.length === 0) return null;
    const best = audioStreams.sort((a, b) => b.bitrate - a.bitrate)[0];
    return best.url;
  } catch {
    return null;
  }
}

// yt-dlp downloads the audio file directly (avoids 403s from googlevideo)
export async function ytdlpDownload(videoId: string): Promise<{ buffer: Buffer; format: string } | null> {
  const tempPath = join(/* turbopackIgnore: true */ tmpdir(), `yt-dlp-${videoId}-${Date.now()}`);

  try {
    const { stdout } = await execFileAsync(YT_DLP, [
      `https://www.youtube.com/watch?v=${videoId}`,
      "-f", "bestaudio/best",
      "-o", `${tempPath}.%(ext)s`,
      "--no-warnings",
      "--no-playlist",
      "--print", "after_move:filepath",
    ], { timeout: 60000 });

    const filePath = stdout.trim().split("\n").pop()?.trim();
    if (!filePath) return null;

    const buffer = await readFile(/* turbopackIgnore: true */ filePath);
    const ext = filePath.split(".").pop() || "webm";
    logEvent("youtube.yt_dlp_downloaded");

    // Clean up temp file
    try { await unlink(/* turbopackIgnore: true */ filePath); } catch {}

    return { buffer, format: ext };
  } catch {
    logEvent("youtube.yt_dlp_download_failed");
    return null;
  }
}

export async function getAudioStreamUrl(videoId: string): Promise<string> {
  for (const instance of PIPED_INSTANCES) {
    logEvent("youtube.trying_piped_stream");
    const url = await pipedStreamUrl(videoId, instance);
    if (url) return url;
  }

  throw new Error("No audio streams available from piped — yt-dlp fallback should be used");
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

// Parse "Artist - Title" from a YouTube video title
function parseYouTubeTitle(title: string): { artist: string; name: string } {
  // Try "Artist - Title" pattern (most music videos)
  const dashMatch = title.match(/^(.+?)\s*[-–—]\s*(.+?)(?:\s*[\[(].*)?$/);
  if (dashMatch) {
    return { artist: dashMatch[1].trim(), name: dashMatch[2].trim() };
  }
  return { artist: "Unknown Artist", name: title.trim() };
}

async function fetchVideoInfo(videoId: string): Promise<{ title: string; uploaderName: string; thumbnailUrl: string; duration: number; uploadDate: string | null }> {
  // Try piped first
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${instance}/streams/${videoId}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      return {
        title: data.title || "Unknown",
        uploaderName: data.uploaderName || "",
        thumbnailUrl: data.thumbnailUrl || "",
        duration: data.duration || 0,
        uploadDate: data.uploadDate || null,
      };
    } catch {
      continue;
    }
  }

  // Fall back to yt-dlp
  try {
    const { stdout } = await execFileAsync(YT_DLP, [
      `https://www.youtube.com/watch?v=${videoId}`,
      "--dump-json",
      "--no-download",
      "--no-warnings",
      "--no-playlist",
    ], { timeout: 20000 });

    const data = JSON.parse(stdout);
    return {
      title: data.title || "Unknown",
      uploaderName: data.uploader || data.channel || "",
      thumbnailUrl: data.thumbnail || "",
      duration: data.duration || 0,
      uploadDate: data.upload_date || null,
    };
  } catch {}

  throw new Error("Could not fetch YouTube video info from any source");
}

export async function getYouTubeTrackInfo(videoId: string): Promise<TrackInfo> {
  const data = await fetchVideoInfo(videoId);
  const { artist, name } = parseYouTubeTitle(data.title);

  return {
    name,
    artist: data.uploaderName?.replace(" - Topic", "") || artist,
    albumArtist: null,
    album: "",
    albumArt: data.thumbnailUrl || "",
    duration: formatDuration(data.duration || 0),
    durationMs: (data.duration || 0) * 1000,
    isrc: null,
    genre: null,
    releaseDate: data.uploadDate || null,
    spotifyUrl: "",
    explicit: false,
    trackNumber: null,
    discNumber: null,
    label: null,
    copyright: null,
    totalTracks: null,
  };
}
