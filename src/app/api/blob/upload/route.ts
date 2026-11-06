import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { MAX_SOURCE_BYTES } from "@/lib/config";

export async function POST(request: Request) {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["video/mp4", "video/webm"],
        maximumSizeInBytes: MAX_SOURCE_BYTES,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ purpose: "meeting-analysis" }),
      }),
      onUploadCompleted: async () => {
        // Processing starts only after the browser confirms the meeting record.
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось подготовить загрузку.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
