import type { EnvelopeMetadata } from "./envelope";
import { canUseClientFFmpeg } from "./capability";

export type FFmpegStatus =
  | { type: "loading" }
  | { type: "ready" }
  | { type: "progress"; percent: number }
  | { type: "complete"; buffer: Uint8Array }
  | { type: "error"; message: string };

type StatusCallback = (status: FFmpegStatus) => void;

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<string, StatusCallback>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    new URL("./ffmpeg-worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.id) {
      // Message targeted at a specific request
      const cb = pending.get(msg.id);
      if (cb) {
        cb(msg as FFmpegStatus);
        if (msg.type === "complete" || msg.type === "error") {
          pending.delete(msg.id);
        }
      }
    } else {
      // Broadcast message (loading/ready) — send to all pending
      for (const cb of pending.values()) {
        cb(msg as FFmpegStatus);
      }
    }
  };
  return worker;
}

/**
 * Encode audio using ffmpeg.wasm in a Web Worker.
 * Returns the encoded file as a Uint8Array.
 * Calls onStatus with progress updates.
 * Throws if encoding fails or times out.
 */
export async function encodeInBrowser(
  audio: Uint8Array,
  albumArt: Uint8Array | null,
  metadata: EnvelopeMetadata,
  outputFormat: "mp3" | "flac" | "alac",
  onStatus?: StatusCallback,
  timeoutMs = 180_000,
): Promise<Uint8Array> {
  if (!canUseClientFFmpeg()) {
    throw new Error("Browser does not support client-side ffmpeg");
  }

  const w = getWorker();
  const id = String(++requestId);

  return new Promise<Uint8Array>((resolve, reject) => {
    // Track the most recent status so timeout errors can explain where it stalled.
    let lastStatusLabel = "no status received";

    const timer = setTimeout(() => {
      pending.delete(id);
      console.warn("ffmpeg-bridge.timeout_after_s_last_status");
      reject(new Error(`ffmpeg encoding timed out (last status: ${lastStatusLabel})`));
    }, timeoutMs);

    pending.set(id, (status) => {
      if (status.type === "loading") lastStatusLabel = "loading encoder";
      else if (status.type === "ready") lastStatusLabel = "encoder ready";
      else if (status.type === "progress") lastStatusLabel = `progress ${status.percent}%`;
      onStatus?.(status);
      if (status.type === "complete") {
        clearTimeout(timer);
        resolve(status.buffer);
      } else if (status.type === "error") {
        clearTimeout(timer);
        reject(new Error(status.message));
      }
    });

    // Copy typed arrays so each has its own backing ArrayBuffer —
    // audio and albumArt may share the same buffer (from unpackEnvelope),
    // and postMessage throws DataCloneError if the same buffer is transferred twice.
    const audioCopy = audio.slice();
    const artCopy = albumArt ? albumArt.slice() : null;
    const transferable: ArrayBuffer[] = [audioCopy.buffer as ArrayBuffer];
    if (artCopy) transferable.push(artCopy.buffer as ArrayBuffer);

    w.postMessage(
      { type: "encode", id, audio: audioCopy, albumArt: artCopy, metadata, outputFormat },
      transferable,
    );
  });
}

/** Check if browser supports client-side ffmpeg. */
export { canUseClientFFmpeg } from "./capability";
