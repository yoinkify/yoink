import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execFile }) };
});
vi.mock("fs/promises", () => ({ readFile: mocks.readFile, unlink: mocks.unlink }));
vi.mock("@/lib/logger", () => ({ logEvent: vi.fn() }));

import { getYouTubeTrackInfo, searchYouTube, ytdlpDownload } from "@/lib/youtube";

describe("YouTube without Piped", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(["connection", "timeout", "invalid JSON"])("falls back to direct search after a Piped %s failure", async (failure) => {
    if (failure === "timeout") {
      vi.mocked(fetch).mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    } else if (failure === "invalid JSON") {
      vi.mocked(fetch).mockResolvedValue(new Response("not JSON"));
    }
    mocks.execFile.mockResolvedValue({ stdout: JSON.stringify({
      id: "test-video", title: "Test Song", uploader: "Test Artist", duration: 120,
    }) });

    expect(await searchYouTube("Test Artist Test Song", {
      artist: "Test Artist", title: "Test Song", durationMs: 120000,
    })).toBe("test-video");
    expect(mocks.execFile).toHaveBeenCalledWith(expect.any(String),
      expect.arrayContaining(["--js-runtimes", `node:${process.execPath}`, "ytsearch5:Test Artist Test Song"]),
      { timeout: 20000 });
  });

  it("returns metadata through the Node-enabled fallback", async () => {
    mocks.execFile.mockResolvedValue({ stdout: JSON.stringify({
      title: "Test Artist - Test Song", uploader: "Test Artist - Topic", duration: 120,
    }) });

    expect(await getYouTubeTrackInfo("test-video")).toMatchObject({
      name: "Test Song", artist: "Test Artist", durationMs: 120000,
    });
    expect(mocks.execFile).toHaveBeenCalledWith(expect.any(String),
      expect.arrayContaining(["--js-runtimes", `node:${process.execPath}`, "--dump-json"]),
      { timeout: 20000 });
  });

  it("downloads audio using Node and cleans up the returned file", async () => {
    mocks.execFile.mockResolvedValue({ stdout: "/tmp/test-audio.webm\n" });
    mocks.readFile.mockResolvedValue(Buffer.from("test audio"));
    mocks.unlink.mockResolvedValue(undefined);

    expect(await ytdlpDownload("test-video")).toEqual({ buffer: Buffer.from("test audio"), format: "webm" });
    expect(mocks.execFile).toHaveBeenCalledWith(expect.any(String),
      expect.arrayContaining(["--js-runtimes", `node:${process.execPath}`, "bestaudio/best"]),
      { timeout: 60000 });
    expect(mocks.unlink).toHaveBeenCalledWith("/tmp/test-audio.webm");
  });

  it("returns no result if both Piped and yt-dlp fail", async () => {
    mocks.execFile.mockRejectedValue(new Error("extractor failed"));
    expect(await searchYouTube("missing song")).toBeNull();
    expect(await ytdlpDownload("missing-video")).toBeNull();
  });
});
