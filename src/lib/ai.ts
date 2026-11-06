import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { z } from "zod";
import {
  MAX_TRANSCRIPTION_BYTES,
  PROVIDER_MAX_ATTEMPTS,
  PROVIDER_REQUEST_TIMEOUT_MS,
} from "@/lib/config";
import {
  meetingAnalysisSchema,
  type MeetingAnalysis,
} from "@/lib/types";

type Provider = "Groq" | "Gemini";
type Sleep = (milliseconds: number) => Promise<void>;
type TimedRequest<T> = (timeoutMs: number) => Promise<T>;

export type ProviderCallOptions<T> = {
  request?: TimedRequest<T>;
  sleep?: Sleep;
};

class InvalidProviderResponseError extends Error {}

const analysisJsonSchema = (() => {
  const schema = z.toJSONSchema(meetingAnalysisSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();

function requireSecret(name: "GROQ_API_KEY" | "GEMINI_API_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} не настроен.`);
  return value;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /timeout|timed out/i.test(error.name);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof InvalidProviderResponseError) return false;
  const status = errorStatus(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  return isTimeoutError(error) || error instanceof TypeError;
}

function retryAfterMs(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("headers" in error)) return null;
  const headers = (error as { headers?: unknown }).headers;
  if (!(headers instanceof Headers)) return null;
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function safeProviderError(provider: Provider, error: unknown): Error {
  if (error instanceof InvalidProviderResponseError) return error;
  const status = errorStatus(error);
  if (status === 401 || status === 403) {
    return new Error(`${provider}: проверьте API-ключ и права доступа.`);
  }
  if (status === 429) {
    return new Error(`${provider}: превышен лимит запросов. Повторите обработку позже.`);
  }
  if (status !== undefined && status >= 500) {
    return new Error(`${provider}: сервис временно недоступен. Повторите обработку позже.`);
  }
  if (isTimeoutError(error)) {
    return new Error(`${provider}: превышено время ожидания ответа.`);
  }
  return new Error(`${provider}: не удалось выполнить запрос.`);
}

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function callProviderWithRetry<T>(
  provider: Provider,
  deadlineMs: number,
  request: TimedRequest<T>,
  sleep: Sleep = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 1_000) {
      throw new Error("Общий лимит времени обработки почти исчерпан. Нажмите «Повторить».");
    }
    const timeoutMs = Math.max(
      1_000,
      Math.min(PROVIDER_REQUEST_TIMEOUT_MS, remainingMs - 1_000),
    );
    try {
      return await request(timeoutMs);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === PROVIDER_MAX_ATTEMPTS) {
        throw safeProviderError(provider, error);
      }
      const delayMs = Math.min(
        retryAfterMs(error) ?? 500 * 2 ** (attempt - 1),
        Math.max(0, deadlineMs - Date.now() - 1_000),
      );
      if (delayMs <= 0) break;
      await sleep(delayMs);
    }
  }
  throw safeProviderError(provider, lastError);
}

async function defaultGroqRequest(
  audioPath: string,
  timeoutMs: number,
): Promise<{ text?: string }> {
  const client = new Groq({
    apiKey: requireSecret("GROQ_API_KEY"),
    maxRetries: 0,
    timeout: timeoutMs,
    logLevel: "off",
  });
  return client.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: process.env.GROQ_TRANSCRIPTION_MODEL ?? "whisper-large-v3-turbo",
    response_format: "json",
    temperature: 0,
  });
}

export async function transcribeWithGroq(
  audioPath: string,
  deadlineMs: number,
  options: ProviderCallOptions<{ text?: string }> = {},
): Promise<string> {
  const size = (await stat(audioPath)).size;
  if (size > MAX_TRANSCRIPTION_BYTES) {
    throw new Error(
      `Извлечённое аудио превышает лимит Groq ${MAX_TRANSCRIPTION_BYTES} байт.`,
    );
  }
  const response = await callProviderWithRetry(
    "Groq",
    deadlineMs,
    options.request ?? ((timeoutMs) => defaultGroqRequest(audioPath, timeoutMs)),
    options.sleep,
  );
  if (!response.text?.trim()) {
    throw new InvalidProviderResponseError("Groq вернул пустую транскрибацию.");
  }
  return response.text.trim();
}

async function defaultGeminiRequest(
  transcript: string,
  timeoutMs: number,
): Promise<{ text?: string }> {
  const client = new GoogleGenAI({
    apiKey: requireSecret("GEMINI_API_KEY"),
    httpOptions: buildGeminiHttpOptions(timeoutMs),
  });
  const response = await client.models.generateContent({
    model: process.env.GEMINI_ANALYSIS_MODEL ?? "gemini-2.5-flash",
    contents: transcript,
    config: {
      systemInstruction:
        "Проанализируй расшифровку рабочей встречи. Не придумывай факты. Верни краткое резюме, темы, решения, задачи с исполнителями и сроками, а также открытые вопросы. Пиши по-русски.",
      responseMimeType: "application/json",
      responseJsonSchema: analysisJsonSchema,
    },
  });
  return { text: response.text };
}

export function buildGeminiHttpOptions(timeoutMs: number) {
  return {
    apiVersion: "v1beta",
    timeout: timeoutMs,
    retryOptions: { attempts: 1 },
  } as const;
}

export async function analyzeWithGemini(
  transcript: string,
  deadlineMs: number,
  options: ProviderCallOptions<{ text?: string }> = {},
): Promise<MeetingAnalysis> {
  const response = await callProviderWithRetry(
    "Gemini",
    deadlineMs,
    options.request ?? ((timeoutMs) => defaultGeminiRequest(transcript, timeoutMs)),
    options.sleep,
  );
  if (!response.text?.trim()) {
    throw new InvalidProviderResponseError("Gemini не вернул результат анализа.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new InvalidProviderResponseError("Gemini вернул некорректный JSON.");
  }
  const validation = meetingAnalysisSchema.safeParse(parsed);
  if (!validation.success) {
    throw new InvalidProviderResponseError(
      "Ответ Gemini не соответствует контракту MeetingAnalysis.",
    );
  }
  return validation.data;
}
