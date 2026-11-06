import { describe, expect, it } from "vitest";
import { assertYandexDiskUrl, buildSourceFingerprint, normalizeSourceUrl } from "@/lib/source";

describe("Yandex Disk source identity", () => {
  it("normalizes tracking parameters, host case and trailing slash", () => {
    expect(normalizeSourceUrl("http://DISK.YANDEX.RU/d/example/?utm_source=mail&from=share&b=2&a=1#preview"))
      .toBe("https://disk.yandex.ru/d/example?a=1&b=2");
  });

  it("accepts only known public Yandex Disk hosts", () => {
    expect(assertYandexDiskUrl("https://yadi.sk/d/example")).toBe("https://yadi.sk/d/example");
    expect(() => assertYandexDiskUrl("https://example.com/file.mp4"))
      .toThrow("Поддерживаются только публичные ссылки Яндекс Диска.");
  });

  it("keeps identical metadata stable and detects a changed file", () => {
    const base = {
      normalizedUrl: "https://disk.yandex.ru/d/example",
      resourceId: "resource-1",
      name: "meeting.mp4",
      size: 100,
      modified: "2026-11-06T10:00:00Z",
      md5: "md5-a",
      sha256: "sha-a",
      mimeType: "video/mp4",
    };
    expect(buildSourceFingerprint(base)).toBe(buildSourceFingerprint({ ...base }));
    expect(buildSourceFingerprint(base)).not.toBe(buildSourceFingerprint({ ...base, size: 101, sha256: "sha-b" }));
  });
});
