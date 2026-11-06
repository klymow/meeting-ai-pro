import { after, NextResponse } from "next/server";
import { z } from "zod";
import { MAX_SOURCE_BYTES } from "@/lib/config";
import {
  createUploadMeeting,
  createYandexMeeting,
  listMeetings,
  markStaleMeetings,
  queueRedundantBlob,
} from "@/lib/meetings";
import { processMeeting } from "@/lib/processor";
import { getYandexResourceMetadata } from "@/lib/source";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("upload"),
    title: z.string().trim().min(1).max(200),
    blobUrl: z.string().url(),
    blobPathname: z.string().min(1),
    filename: z.string().min(1).max(255),
    mimeType: z.enum(["video/mp4", "video/webm"]),
    size: z.number().int().positive().max(MAX_SOURCE_BYTES),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    sourceType: z.literal("yandex_disk"),
    title: z.string().trim().max(200).optional(),
    sourceUrl: z.string().url(),
  }),
]);

export async function GET() {
  await markStaleMeetings();
  return NextResponse.json({ meetings: await listMeetings() });
}

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    if (input.sourceType === "upload") {
      const result = await createUploadMeeting(input);
      if (result.created) {
        after(() => processMeeting(result.meeting.id));
      } else {
        await queueRedundantBlob(
          result.meeting.id,
          input.blobUrl,
          input.blobPathname,
        );
      }
      return NextResponse.json({ ...result, duplicate: !result.created });
    }

    const metadata = await getYandexResourceMetadata(input.sourceUrl);
    if (metadata.size > MAX_SOURCE_BYTES) {
      return NextResponse.json(
        { error: "Файл превышает настроенный лимит обработки." },
        { status: 413 },
      );
    }
    if (!/\.(mp4|webm)$/i.test(metadata.name)) {
      return NextResponse.json(
        { error: "По ссылке ожидается файл MP4 или WebM." },
        { status: 400 },
      );
    }
    const result = await createYandexMeeting({
      title: input.title || metadata.name.replace(/\.(mp4|webm)$/i, ""),
      sourceUrl: input.sourceUrl,
      metadata,
    });
    if (result.created) after(() => processMeeting(result.meeting.id));
    return NextResponse.json({ ...result, duplicate: !result.created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Некорректный запрос.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
