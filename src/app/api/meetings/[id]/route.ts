import { del } from "@vercel/blob";
import { after, NextResponse } from "next/server";
import {
  getAliasCleanup,
  getMeeting,
  getMeetingCleanupBlobs,
  markAliasBlobCleaned,
  markStaleMeetings,
} from "@/lib/meetings";

export const runtime = "nodejs";
export const maxDuration = 300;

type MeetingRouteContext = { params: Promise<{ id: string }> };

async function cleanupRedundantBlobs(meetingId: string) {
  for (const item of await getMeetingCleanupBlobs(meetingId)) {
    const target = item.blobUrl ?? item.blobPathname;
    if (!target) continue;
    try {
      await del(target);
      await markAliasBlobCleaned(item.aliasId);
    } catch {
      // A later status read retries cleanup without changing a ready result.
    }
  }
}

export async function GET(
  _request: Request,
  context: MeetingRouteContext,
) {
  const { id } = await context.params;
  await markStaleMeetings();
  const meeting = await getMeeting(id);
  if (!meeting) return NextResponse.json({ error: "Встреча не найдена." }, { status: 404 });

  if (meeting.status === "ready") {
    const alias = await getAliasCleanup(id);
    after(() => cleanupRedundantBlobs(alias?.meetingId ?? meeting.id));
  }
  return NextResponse.json({ meeting, canonicalId: meeting.id });
}
