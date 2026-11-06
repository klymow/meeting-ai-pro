import { createHash } from "node:crypto";
import type { YandexResourceMetadata } from "@/lib/types";

const YANDEX_HOSTS = new Set([
  "disk.yandex.ru",
  "disk.yandex.com",
  "yadi.sk",
  "disk.360.yandex.ru",
]);

export function normalizeSourceUrl(value: string): string {
  const url = new URL(value.trim());
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "from") url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function assertYandexDiskUrl(value: string): string {
  const normalized = normalizeSourceUrl(value);
  const url = new URL(normalized);
  if (!YANDEX_HOSTS.has(url.hostname)) {
    throw new Error("Поддерживаются только публичные ссылки Яндекс Диска.");
  }
  return normalized;
}

export function buildSourceFingerprint(
  metadata: Omit<YandexResourceMetadata, "fingerprint">,
): string {
  const stable = [
    metadata.normalizedUrl,
    metadata.resourceId ?? "",
    String(metadata.size),
    metadata.modified ?? "",
    metadata.md5 ?? "",
    metadata.sha256 ?? "",
  ].join("\n");
  return createHash("sha256").update(stable).digest("hex");
}

type YandexApiResource = {
  type?: string;
  resource_id?: string;
  name?: string;
  size?: number;
  modified?: string;
  md5?: string;
  sha256?: string;
  mime_type?: string;
  message?: string;
};

export async function getYandexResourceMetadata(
  sourceUrl: string,
): Promise<YandexResourceMetadata> {
  const normalizedUrl = assertYandexDiskUrl(sourceUrl);
  const endpoint = new URL("https://cloud-api.yandex.net/v1/disk/public/resources");
  endpoint.searchParams.set("public_key", normalizedUrl);
  const response = await fetch(endpoint, { cache: "no-store" });
  const body = (await response.json()) as YandexApiResource;
  if (!response.ok) {
    throw new Error(body.message || "Яндекс Диск не вернул метаданные файла.");
  }
  if (body.type !== "file" || !body.name || typeof body.size !== "number") {
    throw new Error("Ссылка должна вести на отдельный файл, а не на папку.");
  }
  const base = {
    normalizedUrl,
    resourceId: body.resource_id ?? null,
    name: body.name,
    size: body.size,
    modified: body.modified ?? null,
    md5: body.md5 ?? null,
    sha256: body.sha256 ?? null,
    mimeType: body.mime_type ?? null,
  };
  return { ...base, fingerprint: buildSourceFingerprint(base) };
}

export async function getYandexDownloadUrl(sourceUrl: string): Promise<string> {
  const endpoint = new URL(
    "https://cloud-api.yandex.net/v1/disk/public/resources/download",
  );
  endpoint.searchParams.set("public_key", assertYandexDiskUrl(sourceUrl));
  const response = await fetch(endpoint, { cache: "no-store" });
  const body = (await response.json()) as { href?: string; message?: string };
  if (!response.ok || !body.href) {
    throw new Error(body.message || "Не удалось получить ссылку на скачивание.");
  }
  return body.href;
}
