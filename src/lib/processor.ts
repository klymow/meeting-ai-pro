import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdtemp, realpath, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { del, get, put } from "@vercel/blob";
import ffmpegPath from "ffmpeg-static";
import { analyzeWithGemini, transcribeWithGroq } from "@/lib/ai";
import {
  MAX_DURATION_SECONDS,
  MAX_SOURCE_BYTES,
  MAX_TRANSCRIPTION_BYTES,
  PROCESSING_DEADLINE_RESERVE_MS,
  TMP_BUDGET_BYTES,
} from "@/lib/config";
import {
  getMeetingForProcessing,
  setMeetingBlob,
  updateMeetingStatus,
  verifyOrClaimContentHash,
  type MeetingRecord,
} from "@/lib/meetings";
import { getYandexDownloadUrl } from "@/lib/source";

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]+/g, "-").slice(-120) || "meeting.webm";
}

async function writeLimitedStream(
  stream: ReadableStream<Uint8Array>,
  destination: string,
  limit: number,
): Promise<number> {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(new Error("Файл превышает допустимый размер."));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(stream as import("node:stream/web").ReadableStream),
    limiter,
    createWriteStream(destination),
  );
  return bytes;
}

async function downloadSource(
  meeting: MeetingRecord,
  destination: string,
): Promise<void> {
  if (meeting.source_size && meeting.source_size > MAX_SOURCE_BYTES) {
    throw new Error("Исходный файл превышает настроенный лимит обработки.");
  }
  if (meeting.blob_url) {
    const result = await get(meeting.blob_url, { access: "private" });
    if (!result || !result.stream) throw new Error("Файл не найден в Blob.");
    await writeLimitedStream(result.stream, destination, MAX_SOURCE_BYTES);
    return;
  }
  if (!meeting.source_url) throw new Error("У встречи отсутствует источник файла.");
  const downloadUrl = await getYandexDownloadUrl(meeting.source_url);
  const response = await fetch(downloadUrl, { cache: "no-store" });
  if (!response.ok || !response.body) {
    throw new Error("Не удалось скачать файл с Яндекс Диска.");
  }
  await writeLimitedStream(response.body, destination, MAX_SOURCE_BYTES);
  const blob = await put(
    `meetings/${meeting.id}/${safeFilename(meeting.original_filename ?? "meeting.webm")}`,
    createReadStream(destination),
    {
      access: "private",
      addRandomSuffix: true,
      multipart: true,
      contentType: meeting.mime_type ?? "application/octet-stream",
    },
  );
  await setMeetingBlob(meeting.id, blob.url, blob.pathname);
  meeting.blob_url = blob.url;
  meeting.blob_pathname = blob.pathname;
}

export async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function buildFfmpegArgs(
  source: string,
  destination: string,
  codec: "mp3" | "opus",
): string[] {
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-ac", "1", "-ar", "16000"];
  return codec === "mp3"
    ? [...common, "-codec:a", "libmp3lame", "-b:a", "48k", destination]
    : [...common, "-codec:a", "libopus", "-b:a", "24k", destination];
}

async function runFfmpeg(args: string[]): Promise<void> {
  const binaryPath = await resolveFfmpegPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(/*turbopackIgnore: true*/ binaryPath, args, { windowsHide: true });
    let errorOutput = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput = (errorOutput + chunk.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg не смог извлечь аудио: ${errorOutput || `код ${code}`}`));
    });
  });
}

export async function resolveFfmpegPath(
  configuredPath: string | null = ffmpegPath,
): Promise<string> {
  if (!configuredPath) throw new Error("Бинарник ffmpeg-static недоступен для этой платформы.");
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(`ffmpeg-static вернул не абсолютный путь: ${configuredPath}`);
  }
  try {
    const resolvedPath = await realpath(configuredPath);
    await access(resolvedPath, fsConstants.X_OK);
    return resolvedPath;
  } catch {
    throw new Error(`Бинарник FFmpeg не найден или недоступен: ${configuredPath}`);
  }
}

async function extractAudio(source: string, directory: string): Promise<string> {
  const mp3 = path.join(directory, "meeting-audio.mp3");
  await runFfmpeg(buildFfmpegArgs(source, mp3, "mp3"));
  const sourceBytes = (await stat(source)).size;
  let audioBytes = (await stat(mp3)).size;
  if (sourceBytes + audioBytes > TMP_BUDGET_BYTES) {
    throw new Error("Для обработки недостаточно доступного места в /tmp.");
  }
  if (audioBytes <= MAX_TRANSCRIPTION_BYTES) return mp3;

  await unlink(mp3);
  const opus = path.join(directory, "meeting-audio.ogg");
  await runFfmpeg(buildFfmpegArgs(source, opus, "opus"));
  audioBytes = (await stat(opus)).size;
  if (sourceBytes + audioBytes > TMP_BUDGET_BYTES) {
    throw new Error("Для обработки недостаточно доступного места в /tmp.");
  }
  if (audioBytes > MAX_TRANSCRIPTION_BYTES) {
    throw new Error(
      "Извлечённое аудио превышает лимит Groq даже после сжатия.",
    );
  }
  return opus;
}

export async function processMeeting(meetingId: string): Promise<void> {
  const deadlineMs =
    Date.now() + MAX_DURATION_SECONDS * 1000 - PROCESSING_DEADLINE_RESERVE_MS;
  let tempDirectory: string | null = null;
  let meeting: MeetingRecord | null = null;
  try {
    meeting = await getMeetingForProcessing(meetingId);
    if (!meeting) return;
    await updateMeetingStatus(meeting.id, "receiving");
    tempDirectory = await mkdtemp(path.join(tmpdir(), "meeting-"));
    const sourcePath = path.join(/*turbopackIgnore: true*/
      tempDirectory,
      safeFilename(meeting.original_filename ?? "meeting.webm"),
    );
    await downloadSource(meeting, sourcePath);
    const sourceBytes = (await stat(/*turbopackIgnore: true*/ sourcePath)).size;
    if (sourceBytes > MAX_SOURCE_BYTES || sourceBytes > TMP_BUDGET_BYTES) {
      throw new Error("Исходный файл превышает доступный лимит /tmp.");
    }

    const contentHash = await sha256File(sourcePath);
    const claim = await verifyOrClaimContentHash(meeting, contentHash);
    if (claim.duplicateId) return;

    await updateMeetingStatus(meeting.id, "transcribing");
    const audioPath = await extractAudio(sourcePath, tempDirectory);
    const transcript = await transcribeWithGroq(audioPath, deadlineMs);

    await updateMeetingStatus(meeting.id, "analyzing", { transcript });
    const analysis = await analyzeWithGemini(transcript, deadlineMs);
    await updateMeetingStatus(meeting.id, "ready", { transcript, analysis });

    if (meeting.blob_url || meeting.blob_pathname) {
      try {
        await del(meeting.blob_url ?? meeting.blob_pathname!);
        await updateMeetingStatus(meeting.id, "ready", {
          transcript,
          analysis,
          blobUrl: null,
          blobPathname: null,
        });
      } catch {
        // A cleanup failure must not turn a completed analysis into an error.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка обработки.";
    await updateMeetingStatus(meetingId, "error", { errorMessage: message });
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  }
}
