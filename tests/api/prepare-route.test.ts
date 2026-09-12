import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  detectPlatform: vi.fn(),
  lookupItunesGenre: vi.fn(),
  lookupItunesCatalogIds: vi.fn(),
  fetchBestAudio: vi.fn(),
  fetchLyrics: vi.fn(),
  rateLimit: vi.fn(),
  getCached: vi.fn(),
  resolveTrack: vi.fn(),
  getRequestSource: vi.fn(),
  getClientIp: vi.fn(),
  getRequestLogId: vi.fn(),
  summarizeUrlForLogs: vi.fn(),
  verifyProofOfWork: vi.fn(),
}));

vi.mock("@/lib/spotify", () => ({
  detectPlatform: mocks.detectPlatform,
}));

vi.mock("@/lib/itunes", () => ({
  lookupItunesGenre: mocks.lookupItunesGenre,
  lookupItunesCatalogIds: mocks.lookupItunesCatalogIds,
}));

vi.mock("@/lib/audio-sources", () => ({
  fetchBestAudio: mocks.fetchBestAudio,
}));

vi.mock("@/lib/lyrics", () => ({
  fetchLyrics: mocks.fetchLyrics,
}));

vi.mock("@/lib/ratelimit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/resolve-track", () => ({
  getCached: mocks.getCached,
  resolveTrack: mocks.resolveTrack,
}));

vi.mock("@/lib/request-source", () => ({
  getRequestSource: mocks.getRequestSource,
}));

vi.mock("@/lib/request-privacy", () => ({
  getClientIp: mocks.getClientIp,
  getRequestLogId: mocks.getRequestLogId,
  summarizeUrlForLogs: mocks.summarizeUrlForLogs,
}));

vi.mock("@/lib/proof-of-work-verify", () => ({
  verifyProofOfWork: mocks.verifyProofOfWork,
}));

import { POST } from "@/app/api/prepare/route";

describe("POST /api/prepare", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.rateLimit.mockReturnValue({ allowed: true, retryAfter: 0 });
    mocks.getRequestSource.mockReturnValue("site");
    mocks.getClientIp.mockReturnValue("127.0.0.1");
    mocks.getRequestLogId.mockReturnValue("req-test");
    mocks.summarizeUrlForLogs.mockReturnValue("open.spotify.com/track/test-track");
    mocks.verifyProofOfWork.mockReturnValue(true);
    mocks.lookupItunesGenre.mockResolvedValue(null);
    mocks.lookupItunesCatalogIds.mockResolvedValue({
      trackId: 1,
      collectionId: 2,
      artistId: 3,
      genreId: 4,
    });
    mocks.fetchLyrics.mockResolvedValue("lyrics");
    mocks.fetchBestAudio.mockResolvedValue({
      buffer: Buffer.from([1, 2, 3, 4]),
      source: "youtube",
      format: "mp3",
      bitrate: 320,
      qualityInfo: {
        codec: "mp3",
        sampleRate: 44100,
        bitDepth: 16,
      },
    });
  });

  it("rejects invalid proof-of-work solutions", async () => {
    mocks.verifyProofOfWork.mockReturnValue(false);

    const request = new NextRequest("https://yoink.fun/api/prepare", {
      method: "POST",
      body: JSON.stringify({
        url: "https://open.spotify.com/track/test-track",
        pow: { challenge: "x", nonce: 1, hash: "bad", timestamp: Date.now() },
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "verification failed — please try again",
    });
  });

  it("allows requests without proof-of-work", async () => {
    mocks.detectPlatform.mockReturnValue("spotify");
    mocks.getCached.mockReturnValue({
      name: "Test Track",
      artist: "Test Artist",
      album: "Test Album",
      albumArtist: "Test Artist",
      albumArt: "",
      duration: "3:45",
      durationMs: 225000,
      isrc: "USRC17607839",
      genre: null,
      releaseDate: "2024-01-01",
      spotifyUrl: "https://open.spotify.com/track/test-track",
      explicit: false,
      trackNumber: 3,
      discNumber: 1,
      label: "Yoink Records",
      copyright: "(c) Yoink",
      totalTracks: 12,
    });

    const request = new NextRequest("https://yoink.fun/api/prepare", {
      method: "POST",
      body: JSON.stringify({
        url: "https://open.spotify.com/track/test-track",
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.verifyProofOfWork).not.toHaveBeenCalled();
  });

  it("rejects unsupported URLs", async () => {
    mocks.detectPlatform.mockReturnValue(null);

    const request = new NextRequest("https://yoink.fun/api/prepare", {
      method: "POST",
      body: JSON.stringify({
        url: "https://example.com/not-supported",
        pow: { challenge: "x", nonce: 1, hash: "ok", timestamp: Date.now() },
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "paste a spotify, apple music, or youtube link",
    });
  });

  it("returns a packed audio envelope for valid requests", async () => {
    mocks.detectPlatform.mockReturnValue("spotify");
    mocks.getCached.mockReturnValue({
      name: "Test Track",
      artist: "Test Artist",
      album: "Test Album",
      albumArtist: "Test Artist",
      albumArt: "",
      duration: "3:45",
      durationMs: 225000,
      isrc: "USRC17607839",
      genre: null,
      releaseDate: "2024-01-01",
      spotifyUrl: "https://open.spotify.com/track/test-track",
      explicit: false,
      trackNumber: 3,
      discNumber: 1,
      label: "Yoink Records",
      copyright: "(c) Yoink",
      totalTracks: 12,
    });

    const request = new NextRequest("https://yoink.fun/api/prepare", {
      method: "POST",
      body: JSON.stringify({
        url: "https://open.spotify.com/track/test-track",
        pow: { challenge: "x", nonce: 1, hash: "ok", timestamp: Date.now() },
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    const response = await POST(request);
    const body = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("X-Audio-Source")).toBe("youtube");
    expect(response.headers.get("X-Audio-Format")).toBe("mp3");
    expect(body.length).toBeGreaterThan(0);
  });
});
