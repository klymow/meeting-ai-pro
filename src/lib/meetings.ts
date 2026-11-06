import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { STALE_AFTER_SECONDS, STATUS_LABELS, type MeetingStatus } from "@/lib/config";
import type { Meeting, MeetingAnalysis, YandexResourceMetadata } from "@/lib/types";

type MeetingRow = Omit<Meeting, "source_size" | "analysis"> & {
  source_size: string | number | null;
  analysis: MeetingAnalysis | string | null;
  blob_url: string | null;
  blob_pathname: string | null;
  source_fingerprint: string | null;
  source_md5: string | null;
  source_sha256: string | null;
};

export type MeetingRecord = Meeting & {
  blob_url: string | null;
  blob_pathname: string | null;
  source_fingerprint: string | null;
  source_md5: string | null;
  source_sha256: string | null;
};

function toMeeting(row: MeetingRow): MeetingRecord {
  return {
    ...row,
    source_size: row.source_size === null ? null : Number(row.source_size),
    analysis:
      typeof row.analysis === "string" ? JSON.parse(row.analysis) : row.analysis,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    source_modified_at: row.source_modified_at
      ? new Date(row.source_modified_at).toISOString()
      : null,
  };
}

export async function listMeetings(): Promise<Meeting[]> {
  const sql = db();
  const rows = await sql<MeetingRow[]>`
    SELECT * FROM meetings ORDER BY created_at DESC LIMIT 100
  `;
  return rows.map(toMeeting);
}

export async function markStaleMeetings(): Promise<void> {
  const sql = db();
  await sql`
    UPDATE meetings
    SET status = 'error',
        status_message = ${STATUS_LABELS.error},
        error_message = 'Обработка была прервана или превысила допустимое время. Нажмите «Повторить».',
        updated_at = now()
    WHERE status IN ('receiving', 'transcribing', 'analyzing')
      AND updated_at < now() - (${STALE_AFTER_SECONDS} * interval '1 second')
  `;
}

export async function getMeeting(id: string): Promise<MeetingRecord | null> {
  const sql = db();
  const direct = await sql<MeetingRow[]>`
    SELECT * FROM meetings WHERE id = ${id} LIMIT 1
  `;
  if (direct[0]) return toMeeting(direct[0]);
  const alias = await sql<MeetingRow[]>`
    SELECT m.*
    FROM meeting_aliases a
    JOIN meetings m ON m.id = a.meeting_id
    WHERE a.alias_id = ${id}
    LIMIT 1
  `;
  return alias[0] ? toMeeting(alias[0]) : null;
}

export async function getMeetingForProcessing(
  id: string,
): Promise<MeetingRecord | null> {
  const sql = db();
  const rows = await sql<MeetingRow[]>`
    SELECT * FROM meetings WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? toMeeting(rows[0]) : null;
}

export async function createUploadMeeting(input: {
  title: string;
  blobUrl: string;
  blobPathname: string;
  filename: string;
  mimeType: string;
  size: number;
  contentHash: string;
}): Promise<{ meeting: MeetingRecord; created: boolean }> {
  const sql = db();
  const id = randomUUID();
  const rows = await sql<MeetingRow[]>`
    INSERT INTO meetings (
      id, title, source_type, status, status_message, content_hash,
      blob_url, blob_pathname, original_filename, mime_type, source_size
    ) VALUES (
      ${id}, ${input.title}, 'upload', 'receiving', ${STATUS_LABELS.receiving},
      ${input.contentHash}, ${input.blobUrl}, ${input.blobPathname},
      ${input.filename}, ${input.mimeType}, ${input.size}
    )
    ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING
    RETURNING *
  `;
  if (rows[0]) return { meeting: toMeeting(rows[0]), created: true };
  const existing = await sql<MeetingRow[]>`
    SELECT * FROM meetings WHERE content_hash = ${input.contentHash} LIMIT 1
  `;
  if (!existing[0]) throw new Error("Не удалось разрешить конфликт содержимого.");
  return { meeting: toMeeting(existing[0]), created: false };
}

export async function createYandexMeeting(input: {
  title: string;
  sourceUrl: string;
  metadata: YandexResourceMetadata;
}): Promise<{ meeting: MeetingRecord; created: boolean }> {
  const sql = db();
  const id = randomUUID();
  const rows = await sql<MeetingRow[]>`
    INSERT INTO meetings (
      id, title, source_type, status, status_message, source_url,
      normalized_source_url, source_fingerprint, resource_id, source_size,
      source_modified_at, source_md5, source_sha256, original_filename, mime_type,
      previous_meeting_id
    ) VALUES (
      ${id}, ${input.title}, 'yandex_disk', 'receiving', ${STATUS_LABELS.receiving},
      ${input.sourceUrl}, ${input.metadata.normalizedUrl}, ${input.metadata.fingerprint},
      ${input.metadata.resourceId}, ${input.metadata.size}, ${input.metadata.modified},
      ${input.metadata.md5}, ${input.metadata.sha256}, ${input.metadata.name},
      ${input.metadata.mimeType},
      (
        SELECT id FROM meetings
        WHERE normalized_source_url = ${input.metadata.normalizedUrl}
        ORDER BY created_at DESC LIMIT 1
      )
    )
    ON CONFLICT (source_fingerprint) WHERE source_fingerprint IS NOT NULL DO NOTHING
    RETURNING *
  `;
  if (rows[0]) return { meeting: toMeeting(rows[0]), created: true };
  const existing = await sql<MeetingRow[]>`
    SELECT * FROM meetings WHERE source_fingerprint = ${input.metadata.fingerprint} LIMIT 1
  `;
  if (!existing[0]) throw new Error("Не удалось разрешить конфликт источника.");
  return { meeting: toMeeting(existing[0]), created: false };
}

export async function updateMeetingStatus(
  id: string,
  status: MeetingStatus,
  fields: {
    errorMessage?: string | null;
    transcript?: string;
    analysis?: MeetingAnalysis;
    blobUrl?: string | null;
    blobPathname?: string | null;
  } = {},
): Promise<void> {
  const sql = db();
  await sql`
    UPDATE meetings
    SET status = ${status},
        status_message = ${STATUS_LABELS[status]},
        error_message = ${fields.errorMessage ?? null},
        transcript = COALESCE(${fields.transcript ?? null}, transcript),
        analysis = COALESCE(${fields.analysis ? JSON.stringify(fields.analysis) : null}::jsonb, analysis),
        blob_url = CASE WHEN ${fields.blobUrl === null} THEN NULL ELSE COALESCE(${fields.blobUrl ?? null}, blob_url) END,
        blob_pathname = CASE WHEN ${fields.blobPathname === null} THEN NULL ELSE COALESCE(${fields.blobPathname ?? null}, blob_pathname) END,
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function setMeetingBlob(
  id: string,
  blobUrl: string,
  blobPathname: string,
): Promise<void> {
  const sql = db();
  await sql`
    UPDATE meetings
    SET blob_url = ${blobUrl}, blob_pathname = ${blobPathname}, updated_at = now()
    WHERE id = ${id}
  `;
}

export async function verifyOrClaimContentHash(
  meeting: MeetingRecord,
  actualHash: string,
): Promise<{ duplicateId: string | null }> {
  const sql = db();
  if (meeting.source_type === "upload" && meeting.content_hash !== actualHash) {
    await sql`
      UPDATE meetings SET content_hash = NULL, updated_at = now() WHERE id = ${meeting.id}
    `;
    throw new Error("Контрольная сумма загруженного файла не совпала. Загрузите файл повторно.");
  }
  try {
    await sql`
      UPDATE meetings SET content_hash = ${actualHash}, updated_at = now()
      WHERE id = ${meeting.id}
    `;
    return { duplicateId: null };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "23505") {
      throw error;
    }
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM meetings WHERE content_hash = ${actualHash} AND id <> ${meeting.id} LIMIT 1
    `;
    if (!existing[0]) throw error;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO meeting_aliases (
          alias_id, meeting_id, redundant_blob_url, redundant_blob_pathname
        ) VALUES (
          ${meeting.id}, ${existing[0].id}, ${meeting.blob_url}, ${meeting.blob_pathname}
        ) ON CONFLICT (alias_id) DO NOTHING
      `;
      await tx`DELETE FROM meetings WHERE id = ${meeting.id}`;
    });
    return { duplicateId: existing[0].id };
  }
}

export async function retryMeeting(id: string): Promise<MeetingRecord | null> {
  const sql = db();
  const rows = await sql<MeetingRow[]>`
    UPDATE meetings
    SET status = 'receiving', status_message = ${STATUS_LABELS.receiving},
        error_message = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'error'
    RETURNING *
  `;
  return rows[0] ? toMeeting(rows[0]) : null;
}

export async function getAliasCleanup(id: string): Promise<{
  meetingId: string;
  blobUrl: string | null;
  blobPathname: string | null;
} | null> {
  const sql = db();
  const rows = await sql<
    { meeting_id: string; redundant_blob_url: string | null; redundant_blob_pathname: string | null }[]
  >`
    SELECT meeting_id, redundant_blob_url, redundant_blob_pathname
    FROM meeting_aliases WHERE alias_id = ${id} LIMIT 1
  `;
  if (!rows[0]) return null;
  return {
    meetingId: rows[0].meeting_id,
    blobUrl: rows[0].redundant_blob_url,
    blobPathname: rows[0].redundant_blob_pathname,
  };
}

export async function markAliasBlobCleaned(id: string): Promise<void> {
  const sql = db();
  await sql`
    UPDATE meeting_aliases
    SET redundant_blob_url = NULL, redundant_blob_pathname = NULL
    WHERE alias_id = ${id}
  `;
}

export async function queueRedundantBlob(
  meetingId: string,
  blobUrl: string,
  blobPathname: string,
): Promise<void> {
  const sql = db();
  await sql`
    INSERT INTO meeting_aliases (
      alias_id, meeting_id, redundant_blob_url, redundant_blob_pathname
    ) VALUES (${randomUUID()}, ${meetingId}, ${blobUrl}, ${blobPathname})
  `;
}

export async function getMeetingCleanupBlobs(meetingId: string): Promise<
  Array<{ aliasId: string; blobUrl: string | null; blobPathname: string | null }>
> {
  const sql = db();
  const rows = await sql<
    { alias_id: string; redundant_blob_url: string | null; redundant_blob_pathname: string | null }[]
  >`
    SELECT alias_id, redundant_blob_url, redundant_blob_pathname
    FROM meeting_aliases
    WHERE meeting_id = ${meetingId}
      AND (redundant_blob_url IS NOT NULL OR redundant_blob_pathname IS NOT NULL)
  `;
  return rows.map((row) => ({
    aliasId: row.alias_id,
    blobUrl: row.redundant_blob_url,
    blobPathname: row.redundant_blob_pathname,
  }));
}
