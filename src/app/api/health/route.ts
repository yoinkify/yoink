import { withRequestLogging } from "@/lib/request-logging";
import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

async function check(name: string, fn: () => Promise<boolean>): Promise<{ name: string; ok: boolean }> {
  try {
    return { name, ok: await fn() };
  } catch {
    return { name, ok: false };
  }
}

async function handleGET() {
  const start = Date.now();

  const checks = await Promise.all([
    check("spotify", async () => {
      const id = process.env.SPOTIFY_CLIENT_ID;
      const secret = process.env.SPOTIFY_CLIENT_SECRET;
      if (!id || !secret) return false;
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    }),

    check("ffmpeg", async () => {
      const { stdout } = await execFileAsync("ffmpeg", ["-version"], { timeout: 3000 });
      return stdout.includes("ffmpeg version");
    }),

    check("curl", async () => {
      const { stdout } = await execFileAsync("curl", ["--version"], { timeout: 3000 });
      return stdout.includes("curl");
    }),

    check("lrclib", async () => {
      const proxy = process.env.LRCLIB_PROXY_URL;
      const url = proxy
        ? `${proxy}/api/get?artist_name=test&track_name=test`
        : "https://lrclib.net/api/get?artist_name=test&track_name=test";
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      return res.status === 200 || res.status === 404; // 404 = reachable, just no match
    }),

    check("itunes", async () => {
      const res = await fetch("https://itunes.apple.com/search?term=test&limit=1", {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    }),

    check("deezer", async () => {
      const res = await fetch("https://api.deezer.com/search?q=test&limit=1", {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    }),

    check("tidal", async () => {
      const refreshToken = process.env.TIDAL_REFRESH_TOKEN;
      const clientId = process.env.TIDAL_CLIENT_ID;
      if (!refreshToken || !clientId) {
        // No refresh flow configured — just check if a static token exists
        return !!process.env.TIDAL_ACCESS_TOKEN;
      }
      const params: Record<string, string> = {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        scope: "r_usr w_usr",
      };
      if (process.env.TIDAL_CLIENT_SECRET) params.client_secret = process.env.TIDAL_CLIENT_SECRET;
      const res = await fetch("https://auth.tidal.com/v1/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    }),

    check("piped", async () => {
      const baseUrl = process.env.PIPED_API_URL || "https://pipedapi.kavin.rocks";
      const res = await fetch(`${baseUrl}/trending?region=US`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    }),
  ]);

  const env = {
    spotify: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    piped: !!process.env.PIPED_API_URL,
    deezer: !!process.env.DEEZER_ARL,
    tidal: !!process.env.TIDAL_ACCESS_TOKEN,
    musixmatch: !!process.env.MUSIXMATCH_TOKEN,
    songlink: process.env.SONGLINK_ENABLED === "true",
    lrclib_proxy: !!process.env.LRCLIB_PROXY_URL,
  };

  const allOk = checks.every((c) => c.ok);

  return NextResponse.json({
    status: allOk ? "ok" : "degraded",
    uptime: Math.floor(process.uptime()),
    latency: `${Date.now() - start}ms`,
    checks,
    env,
  });
}

export const GET = withRequestLogging(handleGET, "api.health.started");
