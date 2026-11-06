CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('upload', 'yandex_disk')),
  status text NOT NULL CHECK (status IN ('receiving', 'transcribing', 'analyzing', 'ready', 'error')),
  status_message text NOT NULL,
  error_message text,
  source_url text,
  normalized_source_url text,
  source_fingerprint text,
  resource_id text,
  source_size bigint,
  source_modified_at timestamptz,
  source_md5 text,
  source_sha256 text,
  content_hash text,
  blob_url text,
  blob_pathname text,
  original_filename text,
  mime_type text,
  transcript text,
  analysis jsonb,
  previous_meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS meetings_source_fingerprint_unique
  ON meetings (source_fingerprint)
  WHERE source_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS meetings_content_hash_unique
  ON meetings (content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS meetings_updated_at_idx ON meetings (updated_at DESC);
CREATE INDEX IF NOT EXISTS meetings_normalized_source_url_idx
  ON meetings (normalized_source_url, created_at DESC)
  WHERE normalized_source_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS meeting_aliases (
  alias_id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  redundant_blob_url text,
  redundant_blob_pathname text,
  created_at timestamptz NOT NULL DEFAULT now()
);
