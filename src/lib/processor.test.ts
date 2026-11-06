import { describe, expect, it } from "vitest";
import path from "node:path";
import { stat } from "node:fs/promises";
import { buildFfmpegArgs, resolveFfmpegPath } from "@/lib/processor";

describe("mandatory audio extraction", () => {
  it("resolves ffmpeg-static to an existing absolute executable", async () => {
    const binaryPath = await resolveFfmpegPath();
    expect(path.isAbsolute(binaryPath)).toBe(true);
    expect((await stat(binaryPath)).isFile()).toBe(true);
  });

  it("rejects a relative FFmpeg path before spawn", async () => {
    await expect(resolveFfmpegPath("node_modules/ffmpeg-static/ffmpeg"))
      .rejects.toThrow("ffmpeg-static вернул не абсолютный путь");
  });

  it.each([
    ["mp3", "libmp3lame", "48k", "audio.mp3"],
    ["opus", "libopus", "24k", "audio.ogg"],
  ] as const)("builds %s extraction for mono 16 kHz audio", (codec, encoder, bitrate, output) => {
    const args = buildFfmpegArgs("video.mp4", output, codec);
    expect(args).toEqual(expect.arrayContaining([
      "-i", "video.mp4", "-vn", "-ac", "1", "-ar", "16000",
      "-codec:a", encoder, "-b:a", bitrate, output,
    ]));
  });
});
