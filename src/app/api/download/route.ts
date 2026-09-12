import { withRequestLogging } from "@/lib/request-logging";
import { logEvent } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  readFile,
  writeFile,
  unlink,
  mkdtemp,
  rmdir,
  readdir,
} from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { detectPlatform } from "@/lib/spotify";
import { setExplicitTag } from "@/lib/mp4-advisory";
import { ffmpegSemaphore } from "@/lib/semaphore";
import { setCatalogIds } from "@/lib/mp4-catalog";
import { rateLimit } from "@/lib/ratelimit";
import { incrementDownloads } from "@/lib/counter";
import { resolveTrack } from "@/lib/resolve-track";
import { getClientIp } from "@/lib/request-privacy";
import { verifyProofOfWork } from "@/lib/proof-of-work-verify";
import { prepareTrackAssets } from "@/lib/track-prep";

const execFileAsync = promisify(execFile);

export const maxDuration = 120;

async function handlePOST(request: NextRequest) {
  let tempDir: string | null = null;


  try {
    const ip = getClientIp(request);

    const { allowed, retryAfter } = rateLimit(`dl:${ip}`, 30, 60_000);
    if (!allowed) {
      return NextResponse.json(
        { error: `slow down — try again in ${retryAfter}s`, rateLimit: true },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const body = await request.json();
    const { pow } = body;
    if (pow && !verifyProofOfWork(pow)) {
      return NextResponse.json({ error: "verification failed — please try again" }, { status: 403 });
    }
    const url = body.url;
    const requestedFormat = body.format as string | undefined; // "mp3" | "flac" | "alac"
    const genreSource = body.genreSource as string | undefined;
    const syncedLyrics = body.syncedLyrics === true;
    const preferLossless = requestedFormat === "flac" || requestedFormat === "alac";

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    logEvent("api.download.request_received");

    const platform = detectPlatform(url);
    if (!platform) {
      return NextResponse.json(
        { error: "paste a spotify, apple music, or youtube link" },
        { status: 400 }
      );
    }

    // Step 1: Resolve track metadata via shared resolver
    // (Spotify API → Song.link → oEmbed → Deezer/iTunes for Spotify tracks)
    // (iTunes lookup by ID → Song.link → Deezer for Apple Music)
    // (Piped → Song.link → Deezer/iTunes search for YouTube)
    const resolved = await resolveTrack(url);
    if (!resolved) {
      return NextResponse.json(
        { error: "couldn't find this track — try a different link" },
        { status: 404 }
      );
    }
    const track = resolved.track;

    // Step 2: Fetch best audio + lyrics + iTunes catalog IDs in parallel
    const { audio, artBuffer, catalogIds, embeddedLyrics } = await prepareTrackAssets(track, {
      requestedFormat,
      genreSource,
      syncedLyrics,
    });
    logEvent("api.download.request_received");
    if (catalogIds) logEvent("api.download.matched_cnid_plid");

    // Step 3: Embed metadata using ffmpeg
    // Only allow lossless output if source audio is actually lossless (FLAC from Deezer or Tidal)
    const canLossless = preferLossless && (audio.source === "deezer" || audio.source === "tidal") && audio.format === "flac";
    const wantAlac = canLossless && requestedFormat === "alac";
    const wantFlac = canLossless && requestedFormat === "flac";
    tempDir = await mkdtemp(join(/* turbopackIgnore: true */ tmpdir(), "dl-"));
    const inputExt = audio.format === "webm" ? "webm" : audio.format === "flac" ? "flac" : "mp3";
    const inputPath = join(tempDir, `input.${inputExt}`);
    const outputExt = wantAlac ? "m4a" : wantFlac ? "flac" : "mp3";
    const outputPath = join(tempDir, `output.${outputExt}`);
    const artPath = join(tempDir, "cover.jpg");

    await writeFile(inputPath, audio.buffer);

    // Download album art (validate URL host)
    let hasArt = false;
    if (artBuffer) {
      try {
        await writeFile(artPath, artBuffer);
        hasArt = true;
      } catch {
        // Skip album art on failure
      }
    }

    // Build ffmpeg args based on source + desired output format
    const ffmpegArgs: string[] = [];
    ffmpegArgs.push("-i", inputPath);

    if (wantAlac) {
      // ALAC output (.m4a)
      if (hasArt) {
        ffmpegArgs.push("-i", artPath, "-map", "0:a", "-map", "1:0");
      }
      ffmpegArgs.push("-c:a", "alac");
      if (hasArt) {
        ffmpegArgs.push("-c:v", "copy", "-disposition:v", "attached_pic");
      }
    } else if (wantFlac) {
      // FLAC output
      if (hasArt) {
        ffmpegArgs.push("-i", artPath, "-map", "0:a", "-map", "1:0");
      }
      if (audio.format === "flac") {
        ffmpegArgs.push("-c:a", "copy"); // Already FLAC, just add metadata
      } else {
        ffmpegArgs.push("-c:a", "flac"); // Transcode to FLAC
      }
      if (hasArt) {
        ffmpegArgs.push("-c:v", "copy", "-disposition:v", "attached_pic");
      }
    } else {
      // MP3 output
      if (hasArt) {
        ffmpegArgs.push("-i", artPath, "-map", "0:a", "-map", "1:0");
      }
      if (audio.source === "deezer" && audio.format === "mp3") {
        ffmpegArgs.push("-c:a", "copy"); // Already MP3, just add metadata
      } else {
        ffmpegArgs.push("-c:a", "libmp3lame", "-b:a", "320k");
      }
      if (hasArt) {
        ffmpegArgs.push(
          "-c:v", "copy",
          "-id3v2_version", "3",
          "-metadata:s:v", "title=Album cover",
          "-metadata:s:v", "comment=Cover (front)",
          "-disposition:v", "attached_pic"
        );
      } else {
        ffmpegArgs.push("-id3v2_version", "3");
      }
    }

    ffmpegArgs.push(
      "-metadata", `title=${track.name}`,
      "-metadata", `artist=${track.artist}`,
      "-metadata", `album=${track.album}`,
    );
    if (track.albumArtist) {
      ffmpegArgs.push("-metadata", `album_artist=${track.albumArtist}`);
    }
    if (track.compilation) {
      ffmpegArgs.push("-metadata", "compilation=1");
    }
    if (track.genre) {
      ffmpegArgs.push("-metadata", `genre=${track.genre}`);
    }
    if (track.releaseDate) {
      ffmpegArgs.push("-metadata", `date=${track.releaseDate}`);
    }
    if (track.trackNumber != null) {
      const trackTag = track.totalTracks ? `${track.trackNumber}/${track.totalTracks}` : `${track.trackNumber}`;
      ffmpegArgs.push("-metadata", `track=${trackTag}`);
    }
    if (track.discNumber != null) {
      ffmpegArgs.push("-metadata", `disc=${track.discNumber}`);
    }
    if (track.isrc) {
      // ISRC — Apple Music's primary matching key
      if (wantAlac) {
        ffmpegArgs.push("-metadata", `ISRC=${track.isrc}`);
      } else if (wantFlac) {
        ffmpegArgs.push("-metadata", `ISRC=${track.isrc}`);
      } else {
        ffmpegArgs.push("-metadata", `TSRC=${track.isrc}`);
      }
    }
    if (track.label) {
      ffmpegArgs.push("-metadata", `label=${track.label}`);
    }
    if (track.copyright) {
      ffmpegArgs.push("-metadata", `copyright=${track.copyright}`);
    }
    if (embeddedLyrics) {
      ffmpegArgs.push("-metadata", `lyrics=${embeddedLyrics}`);
    }
    if (wantAlac || wantFlac) {
      const bitDepth = audio.qualityInfo?.bitDepth ?? 16;
      const sampleRate = audio.qualityInfo?.sampleRate ?? 44100;
      const codec = wantAlac ? "ALAC" : "FLAC";
      ffmpegArgs.push("-metadata", `comment=Lossless (${codec} ${bitDepth}-bit/${(sampleRate / 1000).toFixed(1)}kHz)`);
    }
    ffmpegArgs.push("-y", outputPath);

    try {
      await ffmpegSemaphore.run(() =>
        execFileAsync("ffmpeg", ffmpegArgs, {
          timeout: 120000,
          maxBuffer: 50 * 1024 * 1024,
        })
      );
    } catch {
      // Fallback: try converting without metadata/art
      try {
        const fallbackArgs = wantAlac
          ? ["-y", "-i", inputPath, "-c:a", "alac",
             "-metadata", `title=${track.name}`,
             "-metadata", `artist=${track.artist}`,
             "-metadata", `album=${track.album}`,
             outputPath]
          : wantFlac
            ? ["-y", "-i", inputPath, "-c:a", "flac",
               "-metadata", `title=${track.name}`,
               "-metadata", `artist=${track.artist}`,
               "-metadata", `album=${track.album}`,
               outputPath]
            : ["-y", "-i", inputPath, "-c:a", "libmp3lame", "-b:a", "320k",
               "-metadata", `title=${track.name}`,
               "-metadata", `artist=${track.artist}`,
               "-metadata", `album=${track.album}`,
               outputPath];
        await ffmpegSemaphore.run(() =>
          execFileAsync("ffmpeg", fallbackArgs, {
            timeout: 120000,
            maxBuffer: 50 * 1024 * 1024,
          })
        );
      } catch {
        // ffmpeg completely unavailable — serve raw audio
        const ext = audio.format;
        const mimeMap: Record<string, string> = { webm: "audio/webm", mp3: "audio/mpeg", flac: "audio/flac" };
        const filename = `${track.artist} - ${track.name} · yoink.${ext}`;
        const rawHeaders: Record<string, string> = {
          "Content-Type": mimeMap[ext] || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
          "Content-Length": audio.buffer.length.toString(),
          "X-Audio-Source": audio.source,
          "X-Audio-Quality": `${audio.bitrate}`,
          "X-Audio-Format": ext,
        };
        if (audio.qualityInfo) {
          rawHeaders["X-Audio-Codec"] = audio.qualityInfo.codec;
          rawHeaders["X-Audio-Actual-Bitrate"] = String(audio.qualityInfo.bitrate);
          rawHeaders["X-Audio-Sample-Rate"] = String(audio.qualityInfo.sampleRate);
          rawHeaders["X-Audio-Channels"] = String(audio.qualityInfo.channels);
          if (audio.qualityInfo.bitDepth) rawHeaders["X-Audio-Bit-Depth"] = String(audio.qualityInfo.bitDepth);
          rawHeaders["X-Audio-Upscaled"] = String(audio.qualityInfo.isUpscaled);
        }
        if (audio.verification) {
          rawHeaders["X-Audio-Verified"] = String(audio.verification.verified);
          rawHeaders["X-Audio-Verify-Confidence"] = String(audio.verification.confidence);
        }
        return new NextResponse(new Uint8Array(audio.buffer), { headers: rawHeaders });
      }
    }

    const outputBuffer = await readFile(/* turbopackIgnore: true */ outputPath);
    let finalBuffer: Buffer = outputBuffer;
    if (outputExt === "m4a") {
      if (track.explicit) finalBuffer = setExplicitTag(finalBuffer);
      if (catalogIds) finalBuffer = setCatalogIds(finalBuffer, catalogIds);
    }
    const filename = `${track.artist} - ${track.name} · yoink.${outputExt}`;
    const contentType = wantAlac ? "audio/mp4" : wantFlac ? "audio/flac" : "audio/mpeg";
    const qualityLabel = (wantFlac || wantAlac) && audio.format === "flac" ? "lossless" : `${audio.bitrate}`;

    const responseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "Content-Length": finalBuffer.length.toString(),
      "X-Audio-Source": audio.source,
      "X-Audio-Quality": qualityLabel,
      "X-Audio-Format": outputExt,
    };
    if (audio.qualityInfo) {
      responseHeaders["X-Audio-Codec"] = audio.qualityInfo.codec;
      responseHeaders["X-Audio-Actual-Bitrate"] = String(audio.qualityInfo.bitrate);
      responseHeaders["X-Audio-Sample-Rate"] = String(audio.qualityInfo.sampleRate);
      responseHeaders["X-Audio-Channels"] = String(audio.qualityInfo.channels);
      if (audio.qualityInfo.bitDepth) responseHeaders["X-Audio-Bit-Depth"] = String(audio.qualityInfo.bitDepth);
      responseHeaders["X-Audio-Upscaled"] = String(audio.qualityInfo.isUpscaled);
    }
    if (audio.verification) {
      responseHeaders["X-Audio-Verified"] = String(audio.verification.verified);
      responseHeaders["X-Audio-Verify-Confidence"] = String(audio.verification.confidence);
    }

    incrementDownloads().catch(() => {});
    return new NextResponse(new Uint8Array(finalBuffer), { headers: responseHeaders });
  } catch {
    logEvent("api.download.error");
    return NextResponse.json({ error: "download failed — please try again" }, { status: 500 });
  } finally {
    if (tempDir) {
      try {
        const files = await readdir(/* turbopackIgnore: true */ tempDir);
        await Promise.all(files.map((f) => unlink(join(tempDir!, f))));
        await rmdir(tempDir);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

export const POST = withRequestLogging(handlePOST, "api.download.started");
