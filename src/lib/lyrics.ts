import { logEvent } from "@/lib/logger";
import { execFile } from "child_process";
import { promisify } from "util";
import { request as httpsRequest } from "https";
import { fetchMusixmatchLyrics } from "./musixmatch";

const execFileAsync = promisify(execFile);

function getLrclibBase(): string {
  return process.env.LRCLIB_PROXY_URL || "https://lrclib.net";
}

async function lrclibGet(path: string): Promise<string> {
  const base = getLrclibBase();
  const url = `${base}${path}`;
  logEvent("lyrics.fetching");

  // If using a proxy, regular fetch should work fine
  if (process.env.LRCLIB_PROXY_URL) {
    const res = await fetch(url, {
      headers: { "User-Agent": "yoink/1.0 (https://yoinkify.com)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // Direct access: try curl first (different TLS stack)
  try {
    const { stdout } = await execFileAsync(
      "curl",
      ["-s", "--max-time", "15", "-H", "User-Agent: yoink/1.0", url],
      { timeout: 16000 }
    );
    if (stdout.trim()) return stdout;
  } catch {
    // curl not available or failed
  }

  // Fallback: Node https module
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("timeout"));
    }, 15000);
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          clearTimeout(timer);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

async function fetchFromLrclib(
  artist: string,
  title: string
): Promise<string | null> {
  // Try exact match first
  try {
    const raw = await lrclibGet(
      `/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`
    );
    logEvent("lyrics.get_response_length");
    const data = JSON.parse(raw);
    const lyrics = data.syncedLyrics || data.plainLyrics || null;
    if (lyrics) return lyrics;
  } catch {
    logEvent("lyrics.get_failed");
  }

  // Fall back to search endpoint (more forgiving matching)
  try {
    const raw = await lrclibGet(
      `/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`
    );
    logEvent("lyrics.search_response_length");
    const results = JSON.parse(raw);
    if (!Array.isArray(results) || results.length === 0) return null;

    for (const r of results) {
      if (r.syncedLyrics) return r.syncedLyrics;
    }
    for (const r of results) {
      if (r.plainLyrics) return r.plainLyrics;
    }

    return null;
  } catch {
    logEvent("lyrics.search_failed");
    return null;
  }
}

export async function fetchLyrics(
  artist: string,
  title: string
): Promise<string | null> {
  const lrclib = await fetchFromLrclib(artist, title);
  if (lrclib) return lrclib;

  const mxm = await fetchMusixmatchLyrics(artist, title);
  if (mxm) return mxm;

  return null;
}
