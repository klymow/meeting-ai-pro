import { after, NextResponse } from "next/server";
import { processMeeting } from "@/lib/processor";
import { retryMeeting } from "@/lib/meetings";

export const runtime = "nodejs";
export const maxDuration = 300;

type MeetingRetryRouteContext = { params: Promise<{ id: string }> };

export async function POST(
  _request: Request,
  context: MeetingRetryRouteContext,
) {
  const { id } = await context.params;
  const meeting = await retryMeeting(id);
  if (!meeting) {
    return NextResponse.json(
      { error: "Повторить можно только встречу со статусом «Ошибка»." },
      { status: 409 },
    );
  }
  after(() => processMeeting(meeting.id));
  return NextResponse.json({ meeting });
}
