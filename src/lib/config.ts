// Keep this in sync with the statically analyzable `maxDuration` route exports.
export const MAX_DURATION_SECONDS = 300;
export const STALE_GRACE_SECONDS = Number(
  process.env.MEETING_STALE_GRACE_SECONDS ?? 60,
);
export const STALE_AFTER_SECONDS = MAX_DURATION_SECONDS + STALE_GRACE_SECONDS;
export const MAX_SOURCE_BYTES = Number(
  process.env.MAX_SOURCE_BYTES ?? 1024 * 1024 * 1024,
);
export const TMP_BUDGET_BYTES = Number(
  process.env.TMP_BUDGET_BYTES ?? 1280 * 1024 * 1024,
);
export const GROQ_FREE_TIER_MAX_AUDIO_BYTES = 25_000_000;
export const MAX_TRANSCRIPTION_BYTES = Math.min(
  Number(process.env.MAX_TRANSCRIPTION_BYTES ?? GROQ_FREE_TIER_MAX_AUDIO_BYTES),
  GROQ_FREE_TIER_MAX_AUDIO_BYTES,
);
export const PROVIDER_REQUEST_TIMEOUT_MS = Math.min(
  Number(process.env.PROVIDER_REQUEST_TIMEOUT_MS ?? 60_000),
  MAX_DURATION_SECONDS * 1000,
);
export const PROVIDER_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(Number(process.env.PROVIDER_MAX_ATTEMPTS ?? 2), 3),
);
export const PROCESSING_DEADLINE_RESERVE_MS = 10_000;

export const INTERMEDIATE_STATUSES = [
  "receiving",
  "transcribing",
  "analyzing",
] as const;

export const STATUS_LABELS = {
  receiving: "Получение файла",
  transcribing: "Распознавание речи",
  analyzing: "AI-анализ",
  ready: "Готово",
  error: "Ошибка",
} as const;

export type MeetingStatus = keyof typeof STATUS_LABELS;
