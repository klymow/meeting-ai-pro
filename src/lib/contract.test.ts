import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_DURATION_SECONDS, STALE_AFTER_SECONDS, STALE_GRACE_SECONDS, STATUS_LABELS } from "@/lib/config";

const root = process.cwd();

describe("processing contract", () => {
  it("exposes exactly the required user-facing statuses", () => {
    expect(Object.values(STATUS_LABELS)).toEqual([
      "Получение файла", "Распознавание речи", "AI-анализ", "Готово", "Ошибка",
    ]);
  });

  it("marks stale work only after maxDuration plus grace", () => {
    expect(STALE_AFTER_SECONDS).toBe(MAX_DURATION_SECONDS + STALE_GRACE_SECONDS);
    expect(MAX_DURATION_SECONDS).toBe(300);
  });

  it("keeps route maxDuration aligned with the stale threshold", () => {
    for (const route of [
      "src/app/api/meetings/route.ts",
      "src/app/api/meetings/[id]/route.ts",
      "src/app/api/meetings/[id]/retry/route.ts",
    ]) {
      expect(readFileSync(path.join(root, route), "utf8"))
        .toContain(`export const maxDuration = ${MAX_DURATION_SECONDS};`);
    }
  });

  it("defines database-level race protection and version linkage", () => {
    const schema = readFileSync(path.join(root, "db/schema.sql"), "utf8");
    expect(schema).toContain("meetings_source_fingerprint_unique");
    expect(schema).toContain("meetings_content_hash_unique");
    expect(schema).toContain("previous_meeting_id uuid REFERENCES meetings(id)");
    expect(schema).toContain("updated_at timestamptz NOT NULL DEFAULT now()");
  });
});
