import type { MeetingStatus } from "@/lib/config";
import { z } from "zod";

export const meetingAnalysisSchema = z.object({
  summary: z.string(),
  topics: z.array(z.string()),
  decisions: z.array(z.string()),
  tasks: z.array(z.object({
    task: z.string(),
    assignee: z.string().nullable(),
    deadline: z.string().nullable(),
  }).strict()),
  open_questions: z.array(z.string()),
}).strict();

export type MeetingAnalysis = z.infer<typeof meetingAnalysisSchema>;

export type Meeting = {
  id: string;
  title: string;
  source_type: "upload" | "yandex_disk";
  status: MeetingStatus;
  status_message: string;
  error_message: string | null;
  source_url: string | null;
  normalized_source_url: string | null;
  resource_id: string | null;
  source_size: number | null;
  source_modified_at: string | null;
  content_hash: string | null;
  original_filename: string | null;
  mime_type: string | null;
  transcript: string | null;
  analysis: MeetingAnalysis | null;
  previous_meeting_id: string | null;
  created_at: string;
  updated_at: string;
};

export type YandexResourceMetadata = {
  normalizedUrl: string;
  resourceId: string | null;
  name: string;
  size: number;
  modified: string | null;
  md5: string | null;
  sha256: string | null;
  mimeType: string | null;
  fingerprint: string;
};
