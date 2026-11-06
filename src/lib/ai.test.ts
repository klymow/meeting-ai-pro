import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeWithGemini,
  buildGeminiHttpOptions,
  callProviderWithRetry,
  transcribeWithGroq,
} from "@/lib/ai";
import { MAX_TRANSCRIPTION_BYTES, PROVIDER_MAX_ATTEMPTS } from "@/lib/config";

const validAnalysis = {
  summary: "Краткое содержание",
  topics: ["Планы"],
  decisions: ["Продолжить"],
  tasks: [{ task: "Подготовить отчёт", assignee: "Анна", deadline: null }],
  open_questions: [],
};

let directories: string[] = [];

beforeEach(() => {
  directories = [];
});

afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function audioFile(contents = "audio"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-ai-test-"));
  directories.push(directory);
  const filename = path.join(directory, "audio.mp3");
  await writeFile(filename, contents);
  return filename;
}

function deadline(): number {
  return Date.now() + 120_000;
}

describe("Groq transcription", () => {
  it("returns trimmed text from a mocked Groq response", async () => {
    const request = vi.fn().mockResolvedValue({ text: "  Текст встречи  " });
    await expect(transcribeWithGroq(await audioFile(), deadline(), { request }))
      .resolves.toBe("Текст встречи");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it("does not call Groq when audio exceeds the configured limit", async () => {
    const filename = await audioFile();
    await truncate(filename, MAX_TRANSCRIPTION_BYTES + 1);
    const request = vi.fn();
    await expect(transcribeWithGroq(filename, deadline(), { request }))
      .rejects.toThrow("превышает лимит Groq");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an empty transcription", async () => {
    await expect(transcribeWithGroq(await audioFile(), deadline(), {
      request: vi.fn().mockResolvedValue({ text: "  " }),
    })).rejects.toThrow("Groq вернул пустую транскрибацию");
  });
});

describe("Gemini analysis", () => {
  it("uses the v1beta API without changing timeout or SDK retry policy", () => {
    expect(buildGeminiHttpOptions(42_000)).toEqual({
      apiVersion: "v1beta",
      timeout: 42_000,
      retryOptions: { attempts: 1 },
    });
  });

  it("validates a successful structured response with Zod", async () => {
    const request = vi.fn().mockResolvedValue({ text: JSON.stringify(validAnalysis) });
    await expect(analyzeWithGemini("Расшифровка", deadline(), { request }))
      .resolves.toEqual(validAnalysis);
  });

  it("rejects invalid JSON", async () => {
    await expect(analyzeWithGemini("Расшифровка", deadline(), {
      request: vi.fn().mockResolvedValue({ text: "not-json" }),
    })).rejects.toThrow("Gemini вернул некорректный JSON");
  });

  it("rejects JSON outside the MeetingAnalysis contract", async () => {
    await expect(analyzeWithGemini("Расшифровка", deadline(), {
      request: vi.fn().mockResolvedValue({ text: JSON.stringify({ summary: "Только резюме" }) }),
    })).rejects.toThrow("не соответствует контракту MeetingAnalysis");
  });
});

describe("provider errors, retries and deadline", () => {
  const noSleep = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    noSleep.mockClear();
  });

  it("does not retry 401 and does not expose the original error", async () => {
    const request = vi.fn().mockRejectedValue({
      status: 401,
      message: "bad key secret-value-must-not-leak",
    });
    await expect(callProviderWithRetry("Groq", deadline(), request, noSleep))
      .rejects.toThrow("Groq: проверьте API-ключ и права доступа.");
    expect(request).toHaveBeenCalledOnce();
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("retries 429 and succeeds", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce("ok");
    await expect(callProviderWithRetry("Gemini", deadline(), request, noSleep))
      .resolves.toBe("ok");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries 500 only up to the configured attempt limit", async () => {
    const request = vi.fn().mockRejectedValue({ status: 500 });
    await expect(callProviderWithRetry("Gemini", deadline(), request, noSleep))
      .rejects.toThrow("Gemini: сервис временно недоступен");
    expect(request).toHaveBeenCalledTimes(PROVIDER_MAX_ATTEMPTS);
  });

  it("maps a timeout to a safe message after bounded retries", async () => {
    const timeout = Object.assign(new Error("request timed out with secret-value"), {
      name: "AbortError",
    });
    const request = vi.fn().mockRejectedValue(timeout);
    await expect(callProviderWithRetry("Groq", deadline(), request, noSleep))
      .rejects.toThrow("Groq: превышено время ожидания ответа.");
    expect(request).toHaveBeenCalledTimes(PROVIDER_MAX_ATTEMPTS);
  });

  it("does not start a request when the overall deadline is exhausted", async () => {
    const request = vi.fn();
    await expect(callProviderWithRetry("Gemini", Date.now() + 500, request, noSleep))
      .rejects.toThrow("Общий лимит времени обработки почти исчерпан");
    expect(request).not.toHaveBeenCalled();
  });
});
