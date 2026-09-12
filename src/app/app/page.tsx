"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import Header from "@/components/Header";
import SpotifyInput from "@/components/SpotifyInput";
import FormatToggle, { type Format } from "@/components/FormatToggle";
import MigrationBanner from "@/components/MigrationBanner";
import NoticeBanner from "@/components/NoticeBanner";
import { unpackEnvelope } from "@/lib/client/envelope";
import { encodeInBrowser, canUseClientFFmpeg, type FFmpegStatus } from "@/lib/client/ffmpeg-bridge";
import { zipSync } from "fflate";
import { createProofOfWorkSolution } from "@/lib/proof-of-work";

// Each PoW solution can only be used once (server tracks replays). A fresh
// solve per call, plus a single retry on "verification failed", covers both
// replay and mobile-tab-throttle failures without user-visible errors.
async function postWithPow(url: string, body: Record<string, unknown>): Promise<Response> {
  const send = async () => {
    const pow = await createProofOfWorkSolution(16);
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, pow }),
    });
  };

  const first = await send();
  if (first.status !== 403) return first;

  let shouldRetry = false;
  try {
    const data = await first.clone().json();
    shouldRetry = typeof data?.error === "string" && data.error.toLowerCase().includes("verification failed");
  } catch {
    shouldRetry = false;
  }
  return shouldRetry ? send() : first;
}

interface TrackInfo {
  name: string;
  artist: string;
  album: string;
  albumArt: string;
  duration: string;
  spotifyUrl: string;
  explicit?: boolean;
  videoCover?: string;
}

interface PlaylistInfo {
  name: string;
  image: string;
  tracks: TrackInfo[];
}

type TrackStatus = "pending" | "downloading" | "done" | "error";

interface QualityInfo {
  source: string;
  bitrate: string;
}

type AppState = "idle" | "thinking" | "fetching" | "ready" | "downloading" | "done" | "error";

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [playlist, setPlaylist] = useState<PlaylistInfo | null>(null);
  const [originalUrl, setOriginalUrl] = useState("");
  const [trackStatuses, setTrackStatuses] = useState<TrackStatus[]>([]);
  const [trackErrors, setTrackErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [quality, setQuality] = useState<QualityInfo | null>(null);
  const [format, setFormat] = useState<Format>("mp3");
  const [downloadPhase, setDownloadPhase] = useState<string>("");
  const [genreSource, setGenreSource] = useState<"spotify" | "itunes">("spotify");
  const [syncedLyrics, setSyncedLyrics] = useState(false);
  const abortRef = useRef(false);
  const downloadTriggeredRef = useRef(false);
  const handleSubmit = async (url: string) => {
    setState("thinking");
    setError("");
    setErrorRequestId(null);
    setIsRateLimited(false);
    setTrack(null);
    setPlaylist(null);
    setTrackStatuses([]);
    setTrackErrors({});
    setOriginalUrl(url);
    abortRef.current = false;
    downloadTriggeredRef.current = false;

    try {
      setState("fetching");

      const res = await postWithPow("/api/metadata", {
        url,
        fullMetadata: true,
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.rateLimit) setIsRateLimited(true);
        if (data.requestId) setErrorRequestId(data.requestId);
        throw new Error(data.error || "Failed to fetch info");
      }

      const data = await res.json();

      if (data.type === "playlist") {
        setPlaylist({ name: data.name, image: data.image, tracks: data.tracks });
        setTrackStatuses(new Array(data.tracks.length).fill("pending"));
      } else {
        setTrack(data);
      }
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setState("error");
    }
  };

  const downloadTrack = useCallback(async (trackInfo: TrackInfo): Promise<QualityInfo | false> => {
    const trackUrl = trackInfo.spotifyUrl || originalUrl;
    const useClient = canUseClientFFmpeg();

    if (useClient) {
      try {
        setDownloadPhase("Fetching audio...");
        const res = await postWithPow("/api/prepare", {
          url: trackUrl, format, genreSource, syncedLyrics,
        });

        if (!res.ok) {
          const data = await res.json();
          if (data.rateLimit) setIsRateLimited(true);
          if (data.requestId) setErrorRequestId(data.requestId);
          throw new Error(data.error || "Download failed");
        }

        const audioSource = res.headers.get("X-Audio-Source") || "unknown";
        const envelope = await res.arrayBuffer();
        const { metadata, albumArt, audio } = unpackEnvelope(envelope);

        setDownloadPhase("Converting...");
        const encoded = await encodeInBrowser(
          audio,
          albumArt,
          metadata,
          format as "mp3" | "flac" | "alac",
          (status: FFmpegStatus) => {
            if (status.type === "progress") {
              setDownloadPhase(`Converting... ${status.percent}%`);
            } else if (status.type === "loading") {
              setDownloadPhase("Loading encoder...");
            }
          },
        );

        const extMap: Record<string, string> = { flac: "flac", alac: "m4a", mp3: "mp3" };
        const ext = extMap[format] || "mp3";
        const blob = new Blob([new Uint8Array(encoded)], { type: "application/octet-stream" });
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = `${trackInfo.artist} - ${trackInfo.name} · yoink.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
        setDownloadPhase("");

        const isLosslessOutput = (format === "flac" || format === "alac") && metadata.sourceFormat === "flac";
        const qualityLabel = isLosslessOutput
          ? "lossless"
          : format === "mp3"
            ? "320"
            : `${metadata.sourceBitrate}`;
        return { source: audioSource, bitrate: qualityLabel };
      } catch {
        console.warn("page.failed_falling_back_to_server");
        setDownloadPhase("Converting on server...");
      }
    }

    // Server-side fallback
    try {
      if (!useClient) setDownloadPhase("");
      const res = await postWithPow("/api/download", {
        url: trackUrl, format, genreSource, syncedLyrics,
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.rateLimit) setIsRateLimited(true);
        if (data.requestId) setErrorRequestId(data.requestId);
        throw new Error(data.error || "Download failed");
      }

      const audioSource = res.headers.get("X-Audio-Source") || "youtube";
      const audioBitrate = res.headers.get("X-Audio-Quality") || "~160";
      const audioFormat = res.headers.get("X-Audio-Format") || "mp3";

      const extMap: Record<string, string> = { flac: "flac", m4a: "m4a", alac: "m4a", mp3: "mp3" };
      const ext = extMap[audioFormat] || audioFormat;
      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `${trackInfo.artist} - ${trackInfo.name} · yoink.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      setDownloadPhase("");
      return { source: audioSource, bitrate: audioBitrate };
    } catch {
      setDownloadPhase("");
      return false;
    }
  }, [format, genreSource, originalUrl, syncedLyrics]);

  const handleDownload = async () => {
    if (!track) return;
    setState("downloading");
    setQuality(null);

    const result = await downloadTrack(track);
    if (result) {
      setQuality(result);
      setState("done");
      setTimeout(() => setState("ready"), 3000);
    } else if (!error) {
      setError("couldn't download this track — try again or try a different link");
      setState("error");
    }
  };

  const handleDownloadAll = async () => {
    if (!playlist) return;
    setState("downloading");
    abortRef.current = false;
    setTrackStatuses(new Array(playlist.tracks.length).fill("pending"));

    const useClient = canUseClientFFmpeg();

    if (useClient) {
      try {
        const res = await postWithPow("/api/prepare-playlist", {
          url: originalUrl, format, genreSource, syncedLyrics,
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Playlist download failed");
        }

        const reader = res.body!.getReader();
        let byteBuffer = new Uint8Array(0);
        const encodedFiles: { name: string; data: Uint8Array }[] = [];
        let expectingBinary = 0;
        let currentTrackIndex = -1;

        const processEnvelope = async (envelopeBuffer: ArrayBuffer, index: number) => {
          const { metadata, albumArt, audio } = unpackEnvelope(envelopeBuffer);
          try {
            const encoded = await encodeInBrowser(
              audio, albumArt, metadata,
              format as "mp3" | "flac" | "alac",
              undefined,
              180_000,
            );

            const extMap: Record<string, string> = { flac: "flac", alac: "m4a", mp3: "mp3" };
            const ext = extMap[format] || "mp3";
            const name = `${metadata.artist} - ${metadata.title}.${ext}`.replace(/[/\\:*?"<>|]/g, "_");
            encodedFiles.push({ name, data: new Uint8Array(encoded) });

            setTrackStatuses((prev) => {
              const next = [...prev];
              next[index] = "done";
              return next;
            });
          } catch {
            console.warn("page.track_failed_trying_server_fallback");
            try {
              const track = playlist.tracks[index];
              const trackUrl = track.spotifyUrl || originalUrl;
              const fallbackRes = await postWithPow("/api/download", {
                url: trackUrl, format, genreSource, syncedLyrics,
              });
              if (fallbackRes.ok) {
                const audioFormat = fallbackRes.headers.get("X-Audio-Format") || "mp3";
                const extMap: Record<string, string> = { flac: "flac", m4a: "m4a", alac: "m4a", mp3: "mp3" };
                const ext = extMap[audioFormat] || audioFormat;
                const blob = await fallbackRes.blob();
                const name = `${track.artist} - ${track.name}.${ext}`.replace(/[/\\:*?"<>|]/g, "_");
                encodedFiles.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
                setTrackStatuses((prev) => {
                  const next = [...prev];
                  next[index] = "done";
                  return next;
                });
                return;
              }
            } catch {}
            setTrackStatuses((prev) => {
              const next = [...prev];
              next[index] = "error";
              return next;
            });
            setTrackErrors((prev) => ({ ...prev, [index]: "not available on any audio source" }));
          }
        };

        let encodeChain = Promise.resolve();

        const handleEvent = (event: Record<string, unknown>) => {
          if (event.type === "batch") {
            setTrackStatuses((prev) => {
              const next = [...prev];
              for (const idx of event.indices as number[]) next[idx] = "downloading";
              return next;
            });
          } else if (event.type === "track") {
            currentTrackIndex = event.index as number;
            expectingBinary = event.size as number;
          } else if (event.type === "error") {
            const idx = event.index as number;
            setTrackStatuses((prev) => {
              const next = [...prev];
              next[idx] = "error";
              return next;
            });
            if (event.reason) {
              setTrackErrors((prev) => ({ ...prev, [idx]: event.reason as string }));
            }
          }
        };

        while (true) {
          if (abortRef.current) break;
          const { done, value } = await reader.read();
          if (done) break;

          const combined = new Uint8Array(byteBuffer.length + value.length);
          combined.set(byteBuffer);
          combined.set(value, byteBuffer.length);
          byteBuffer = combined;

          while (expectingBinary > 0 && byteBuffer.length >= expectingBinary) {
            const envelopeBytes = byteBuffer.slice(0, expectingBinary).buffer;
            byteBuffer = byteBuffer.slice(expectingBinary);
            expectingBinary = 0;

            const idx = currentTrackIndex;
            encodeChain = encodeChain.then(() => processEnvelope(envelopeBytes, idx));
          }

          if (expectingBinary > 0) continue;

          while (true) {
            const newlineIdx = byteBuffer.indexOf(0x0A);
            if (newlineIdx === -1) break;

            const lineBytes = byteBuffer.slice(0, newlineIdx);
            byteBuffer = byteBuffer.slice(newlineIdx + 1);

            const line = new TextDecoder().decode(lineBytes).trim();
            if (!line) continue;

            try {
              const event = JSON.parse(line);
              handleEvent(event);
              if (expectingBinary > 0) break;
            } catch {}
          }
        }

        await encodeChain;

        if (encodedFiles.length === 0) {
          throw new Error("All tracks failed to download");
        }

        const zipEntries: Record<string, Uint8Array> = {};
        const usedNames = new Set<string>();
        for (const file of encodedFiles) {
          let name = file.name;
          if (usedNames.has(name)) {
            const ext = name.lastIndexOf(".");
            const base = name.slice(0, ext);
            const extStr = name.slice(ext);
            let counter = 2;
            while (usedNames.has(`${base} (${counter})${extStr}`)) counter++;
            name = `${base} (${counter})${extStr}`;
          }
          usedNames.add(name);
          zipEntries[name] = file.data;
        }

        const zipBuffer = zipSync(zipEntries, { level: 0 });
        const zipFilename = (playlist.name.replace(/[/\\:*?"<>|]/g, "_")) + ".zip";
        const zipBlob = new Blob([new Uint8Array(zipBuffer)], { type: "application/zip" });
        const downloadUrl = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = zipFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);

        setState("done");
        setTimeout(() => setState("ready"), 3000);
        return;
      } catch {
        console.warn("page.playlist_failed_entirely_falling_back_to_server");
        setTrackStatuses(new Array(playlist.tracks.length).fill("pending"));
      }
    }

    // Server-side fallback — keep existing logic exactly as-is
    try {
      const res = await postWithPow("/api/download-playlist", {
        url: originalUrl, format, genreSource, syncedLyrics,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Playlist download failed");
      }

      const reader = res.body!.getReader();
      const zipChunks: Uint8Array[] = [];
      let byteBuffer = new Uint8Array(0);
      let zipFilename = `${playlist.name}.zip`;
      let zipStarted = false;

      const handleEvent = (event: { type: string; indices?: number[]; index?: number; error?: string; filename?: string }) => {
        if (event.type === "batch") {
          setTrackStatuses((prev) => {
            const next = [...prev];
            for (const idx of event.indices!) next[idx] = "downloading";
            return next;
          });
        } else if (event.type === "done") {
          setTrackStatuses((prev) => {
            const next = [...prev];
            next[event.index!] = "done";
            return next;
          });
        } else if (event.type === "error") {
          setTrackStatuses((prev) => {
            const next = [...prev];
            next[event.index!] = "error";
            return next;
          });
        } else if (event.type === "fatal") {
          throw new Error(event.error);
        } else if (event.type === "zip") {
          zipFilename = event.filename || zipFilename;
          zipStarted = true;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (zipStarted) {
          zipChunks.push(value);
          continue;
        }

        const combined = new Uint8Array(byteBuffer.length + value.length);
        combined.set(byteBuffer);
        combined.set(value, byteBuffer.length);
        byteBuffer = combined;

        while (true) {
          const newlineIdx = byteBuffer.indexOf(0x0A);
          if (newlineIdx === -1) break;

          const lineBytes = byteBuffer.slice(0, newlineIdx);
          byteBuffer = byteBuffer.slice(newlineIdx + 1);

          const line = new TextDecoder().decode(lineBytes).trim();
          if (!line) continue;

          try {
            const event = JSON.parse(line);
            handleEvent(event);

            if (zipStarted && byteBuffer.length > 0) {
              zipChunks.push(byteBuffer);
              byteBuffer = new Uint8Array(0);
              break;
            }
          } catch {}
        }
      }

      const totalSize = zipChunks.reduce((sum, c) => sum + c.length, 0);
      const zipArray = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of zipChunks) {
        zipArray.set(chunk, offset);
        offset += chunk.length;
      }
      const zipBlob = new Blob([zipArray], { type: "application/zip" });
      const downloadUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = zipFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);

      setState("done");
      setTimeout(() => setState("ready"), 3000);
    } catch (err) {
      setTrackStatuses((prev) => prev.map((s) => s === "downloading" || s === "pending" ? "error" : s));
      setError(err instanceof Error ? err.message : "Playlist download failed");
      setState("error");
    }
  };

  // Enter key triggers download when track/playlist is ready
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (state !== "ready") return;
      if (downloadTriggeredRef.current) return;
      // Don't trigger if focused on the input
      const active = document.activeElement;
      if (active && active.tagName === "INPUT") return;
      downloadTriggeredRef.current = true;
      if (track) handleDownload();
      else if (playlist) handleDownloadAll();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const handleReset = () => {
    setState("idle");
    setTrack(null);
    setPlaylist(null);
    setTrackStatuses([]);
    setTrackErrors({});
    setError("");
    setErrorRequestId(null);
    setQuality(null);
    abortRef.current = true;
  };

  const doneCount = trackStatuses.filter((s) => s === "done").length;
  const totalCount = trackStatuses.length;

  return (
    <div className="min-h-screen flex flex-col bg-grid">
      <MigrationBanner />
      <NoticeBanner />
      <Header />

      <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-xl space-y-8">
          {/* Title */}
          <div className="space-y-3 animate-fade-in-up" style={{ opacity: 0 }}>
            <h1 className="text-4xl sm:text-5xl font-bold leading-tight">
              <span className="text-lavender">y</span>
              <span className="logo-expand" style={{ animationDelay: "0.3s" }}>o</span>
              <span className="logo-expand" style={{ animationDelay: "0.4s" }}>i</span>
              <span className="logo-expand" style={{ animationDelay: "0.5s" }}>n</span>
              <span className="text-lavender">k</span>
            </h1>
            <h2 className="text-sm text-subtext0/80 leading-relaxed max-w-sm font-normal">
              paste a spotify link. get the {format}.<br />
              tracks, playlists, albums. metadata included.
            </h2>
          </div>

          {/* Input + Format Toggle */}
          <div className="space-y-3">
            <SpotifyInput
              onSubmit={handleSubmit}
              disabled={state === "fetching" || state === "downloading"}
              clear={state === "done"}
            />
            <div className="flex items-center justify-between flex-wrap gap-2 animate-fade-in-up" style={{ animationDelay: "150ms", opacity: 0 }}>
              <FormatToggle
                value={format}
                onChange={setFormat}
                disabled={state === "downloading"}
              />
              <div className="flex items-center gap-2 text-[10px] tracking-wider">
                <button
                  onClick={() => setGenreSource(genreSource === "spotify" ? "itunes" : "spotify")}
                  disabled={state === "downloading"}
                  className={`transition-colors duration-200 disabled:opacity-50 ${
                    genreSource === "itunes" ? "text-lavender" : "text-overlay0/50 hover:text-overlay0/70"
                  }`}
                >
                  {genreSource === "itunes" ? "iTunes genres ✓" : "iTunes genres"}
                </button>
                <span className="text-overlay0/20">/</span>
                <div className="group relative">
                  <button
                    onClick={() => setSyncedLyrics(!syncedLyrics)}
                    disabled={state === "downloading"}
                    className={`transition-colors duration-200 disabled:opacity-50 ${
                      syncedLyrics ? "text-lavender" : "text-overlay0/50 hover:text-overlay0/70"
                    }`}
                  >
                    {syncedLyrics ? "synced lyrics ✓" : "synced lyrics"}
                  </button>
                  <div className="absolute bottom-full right-0 mb-2 px-3 py-1.5 rounded-md bg-surface0 text-[9px] text-subtext0 tracking-wider whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-200">
                    embeds LRC timestamps — works with foobar2000, Poweramp, Plexamp
                  </div>
                </div>
                <span className="text-overlay0/20">|</span>
                <span className="text-overlay0/30">
                  {format === "mp3" ? "~8mb per track" : "~40mb per track"}
                </span>
              </div>
            </div>
          </div>

          {/* Thinking (proof-of-work) */}
          {state === "thinking" && (
            <div className="animate-fade-in-up border border-surface0/60 rounded-lg p-6 flex items-center gap-4 bg-mantle/30" style={{ opacity: 0 }}>
              <span className="text-sm text-subtext0 animate-text-shimmer">thinking...</span>
            </div>
          )}

          {/* Loading */}
          {state === "fetching" && (
            <div className="animate-fade-in-up border border-surface0/60 rounded-lg p-6 flex items-center gap-4 bg-mantle/30" style={{ opacity: 0 }}>
              <span className="text-sm text-subtext0 animate-text-shimmer">fetching info</span>
            </div>
          )}

          {/* Error */}
          {state === "error" && (
            <div className="animate-fade-in-up border border-red/20 rounded-lg p-6 space-y-4 bg-red/5" style={{ opacity: 0 }}>
              <div className="flex items-start gap-3">
                <span className="text-red text-xs mt-0.5">!</span>
                <div className="text-sm text-red/90 leading-relaxed">
                  <p>{error}</p>
                  {isRateLimited && (
                    <p className="mt-2 text-xs text-overlay0/60">
                      see{" "}
                      <Link href="/terms" className="text-lavender/70 hover:text-lavender underline transition-colors">
                        rate limits
                      </Link>
                      {" "}for details.{" "}
                      <Link href="/roadmap" className="text-lavender/70 hover:text-lavender underline transition-colors">
                        higher limits coming soon
                      </Link>
                    </p>
                  )}
                  {errorRequestId && (
                    <p className="mt-2 text-xs text-overlay0/40 font-mono">
                      ref: {errorRequestId}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <button
                  onClick={handleReset}
                  className="btn-press text-xs text-subtext0 hover:text-text transition-colors uppercase tracking-wider"
                >
                  try again
                </button>
                <Link
                  href="/feedback"
                  className="text-xs text-overlay0/50 hover:text-overlay0 transition-colors"
                >
                  report bug
                </Link>
              </div>
            </div>
          )}

          {/* Single Track Card */}
          {track && (state === "ready" || state === "downloading" || state === "done") && (
            <div className="animate-fade-in-up border border-surface0/60 rounded-lg overflow-hidden bg-mantle/40" style={{ opacity: 0 }}>
              {state === "downloading" && (
                <div className="progress-bar h-1 bg-surface0/40">
                  <div className="progress-bar-fill" />
                </div>
              )}
              {state === "done" && (
                <div className="progress-bar h-1 bg-surface0/40">
                  <div className="progress-bar-fill done" />
                </div>
              )}
              {state === "ready" && <div className="h-1" />}

              <div className="p-4 sm:p-6 flex gap-4 sm:gap-5 stagger">
                <div className="w-[72px] h-[72px] sm:w-[100px] sm:h-[100px] flex-shrink-0 relative">
                  {track.videoCover ? (
                    <video
                      src={track.videoCover}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="art-glow w-full h-full rounded-lg object-cover animate-fade-in"
                      style={{ opacity: 0 }}
                      poster={track.albumArt}
                    />
                  ) : track.albumArt ? (
                    <Image
                      src={track.albumArt}
                      alt={track.album}
                      fill
                      sizes="(max-width: 640px) 72px, 100px"
                      className="art-glow rounded-lg object-cover animate-fade-in"
                      style={{ opacity: 0 }}
                      unoptimized
                    />
                  ) : (
                    <div className="art-glow w-full h-full rounded-lg bg-surface0/30" />
                  )}
                </div>
                <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
                  <p className="text-base font-bold text-text truncate animate-slide-in" style={{ opacity: 0 }}>
                    {track.name}
                    {track.explicit && (
                      <span className="inline-flex items-center justify-center ml-1.5 px-1 py-px text-[9px] font-bold leading-none uppercase tracking-wide rounded bg-overlay0/20 text-overlay0 align-middle">E</span>
                    )}
                  </p>
                  <p className="text-sm text-subtext0 truncate animate-slide-in" style={{ opacity: 0, animationDelay: "60ms" }}>
                    {track.artist}
                  </p>
                  <div className="flex items-center gap-3 animate-slide-in" style={{ opacity: 0, animationDelay: "120ms" }}>
                    <p className="text-xs text-overlay0 truncate">{track.album}</p>
                    <span className="text-overlay0/40">·</span>
                    <p className="text-xs text-overlay0 flex-shrink-0">{track.duration}</p>
                  </div>
                  {quality && state === "done" && (
                    <p className="text-[10px] text-overlay0/60 animate-fade-in" style={{ opacity: 0 }}>
                      {quality.bitrate === "lossless" ? "lossless" : `${quality.source === "youtube" ? "~" : ""}${quality.bitrate}kbps`} via {quality.source}
                    </p>
                  )}
                </div>
              </div>

              <div className="border-t border-surface0/60 flex">
                <button
                  onClick={handleDownload}
                  disabled={state === "downloading"}
                  className={`btn-press flex-1 px-4 py-3.5 text-xs font-bold uppercase tracking-wider transition-all duration-200 disabled:opacity-50 hover:bg-surface0/20 ${
                    state === "done"
                      ? "text-green"
                      : state === "downloading"
                        ? "text-lavender/70"
                        : "text-lavender"
                  }`}
                >
                  {state === "downloading" && (
                    <span className="animate-text-shimmer">{downloadPhase || "downloading"}</span>
                  )}
                  {state === "done" && "downloaded"}
                  {state === "ready" && `download ${format}`}
                </button>
                <button
                  onClick={handleReset}
                  className="btn-press px-5 py-3.5 text-xs text-overlay0 hover:text-text hover:bg-surface0/20 border-l border-surface0/60 transition-all duration-200 uppercase tracking-wider"
                >
                  new
                </button>
              </div>
            </div>
          )}

          {/* Playlist Card */}
          {playlist && (state === "ready" || state === "downloading" || state === "done") && (
            <div className="animate-fade-in-up border border-surface0/60 rounded-lg overflow-hidden bg-mantle/40" style={{ opacity: 0 }}>
              {state === "downloading" && (
                <div className="h-1 bg-surface0/40">
                  <div
                    className="h-full bg-lavender transition-all duration-500 ease-out"
                    style={{ width: `${totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%` }}
                  />
                </div>
              )}
              {state === "done" && (
                <div className="h-1 bg-surface0/40">
                  <div className="h-full bg-green w-full transition-all duration-300" />
                </div>
              )}
              {state === "ready" && <div className="h-1" />}

              {/* Playlist header */}
              <div className="p-4 sm:p-6 flex gap-4 sm:gap-5">
                {playlist.image && (
                  <div className="relative w-[72px] h-[72px] sm:w-[100px] sm:h-[100px] flex-shrink-0">
                    <Image
                      src={playlist.image}
                      alt={playlist.name}
                      fill
                      sizes="(max-width: 640px) 72px, 100px"
                      className="art-glow rounded-lg object-cover animate-fade-in"
                      style={{ opacity: 0 }}
                      unoptimized
                    />
                  </div>
                )}
                <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
                  <p className="text-base font-bold text-text truncate animate-slide-in" style={{ opacity: 0 }}>
                    {playlist.name}
                  </p>
                  <p className="text-sm text-subtext0 animate-slide-in" style={{ opacity: 0, animationDelay: "60ms" }}>
                    {totalCount} track{totalCount !== 1 && "s"}
                  </p>
                  {state === "downloading" && (
                    <p className="text-xs text-lavender animate-fade-in" style={{ opacity: 0 }}>
                      {doneCount}/{totalCount} downloaded
                    </p>
                  )}
                  {state === "done" && (
                    <p className="text-xs text-green animate-fade-in" style={{ opacity: 0 }}>
                      {doneCount}/{totalCount} downloaded
                    </p>
                  )}
                </div>
              </div>

              {/* Track list */}
              <div className="border-t border-surface0/40 max-h-[320px] overflow-y-auto">
                {playlist.tracks.map((t, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-surface0/20 last:border-b-0 transition-colors duration-200 ${
                      ""
                    }`}
                  >
                    {/* Status indicator */}
                    <div className={`flex-shrink-0 text-center ${trackStatuses[i] === "pending" && t.albumArt ? "w-0 overflow-hidden" : "w-5"}`}>
                      {trackStatuses[i] === "pending" && !t.albumArt && (
                        <span className="text-xs text-overlay0/50">{i + 1}</span>
                      )}
                      {trackStatuses[i] === "downloading" && (
                        <span className="text-xs text-lavender">{i + 1}</span>
                      )}
                      {trackStatuses[i] === "done" && (
                        <span className="text-xs text-green">✓</span>
                      )}
                      {trackStatuses[i] === "error" && (
                        <span className="text-xs text-red cursor-help" title={trackErrors[i] || "download failed"}>!</span>
                      )}
                    </div>

                    {/* Track info */}
                    {t.albumArt ? (
                      <Image
                        src={t.albumArt}
                        alt={t.album}
                        width={40}
                        height={40}
                        className="w-10 h-10 rounded object-cover flex-shrink-0"
                        unoptimized
                      />
                    ) : (
                      <div className="w-10 h-10 rounded bg-surface0/30 flex-shrink-0" />
                    )}

                    <div className="flex-1 min-w-0">
                      <p className={`text-sm truncate ${
                        trackStatuses[i] === "downloading" ? "animate-text-shimmer text-lavender" : trackStatuses[i] === "done" ? "text-subtext0" : "text-text"
                      }`}>
                        {t.name}
                        {t.explicit && (
                          <span className="inline-flex items-center justify-center ml-1 px-0.5 py-px text-[8px] font-bold leading-none uppercase tracking-wide rounded bg-overlay0/20 text-overlay0/70 align-middle">E</span>
                        )}
                      </p>
                      <p className="text-xs text-overlay0 truncate">{t.artist}</p>
                    </div>

                    {/* Duration */}
                    <span className="text-xs text-overlay0/50 flex-shrink-0">{t.duration}</span>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div className="border-t border-surface0/60 flex">
                <button
                  onClick={handleDownloadAll}
                  disabled={state === "downloading"}
                  className={`btn-press flex-1 px-4 py-3.5 text-xs font-bold uppercase tracking-wider transition-all duration-200 disabled:opacity-50 hover:bg-surface0/20 ${
                    state === "done"
                      ? "text-green"
                      : state === "downloading"
                        ? "text-lavender/70"
                        : "text-lavender"
                  }`}
                >
                  {state === "downloading" && (
                    <span className="animate-text-shimmer">downloading</span>
                  )}
                  {state === "done" && "downloaded"}
                  {state === "ready" && "download all"}
                </button>
                <button
                  onClick={handleReset}
                  disabled={state === "downloading"}
                  className="btn-press px-5 py-3.5 text-xs text-overlay0 hover:text-text hover:bg-surface0/20 border-l border-surface0/60 transition-all duration-200 uppercase tracking-wider disabled:opacity-50"
                >
                  new
                </button>
              </div>
            </div>
          )}

          {/* Keyboard hint */}
          {state === "idle" && (
            <div className="animate-fade-in-up flex items-center gap-2 text-xs text-overlay0/40" style={{ opacity: 0, animationDelay: "300ms" }}>
              <kbd className="px-1.5 py-0.5 rounded border border-surface0/60 text-overlay0/50 text-[10px]">Enter</kbd>
              <span>to download</span>
            </div>
          )}

        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-surface0/40 px-6 py-4 flex items-center justify-between text-xs text-overlay0/50">
        <span>yoink</span>
        <div className="flex items-center gap-3 sm:gap-4">
          <Link href="/extras" className="hover:text-text transition-colors duration-200">extras</Link>
          <Link href="/legal" className="hover:text-text transition-colors duration-200">legal</Link>
          <Link href="/source" className="hover:text-text transition-colors duration-200">source</Link>
        </div>
      </footer>
    </div>
  );
}
