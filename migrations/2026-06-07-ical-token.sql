-- Per-user token for the public iCal feed subscription URL.
-- Idempotent. Existing rows get a generated uuid each (uuid_generate_v4 is volatile).
BEGIN;
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS ical_token uuid DEFAULT uuid_generate_v4() UNIQUE;
-- Backfill any rows that somehow ended up NULL (e.g. column added without default in the past).
UPDATE public.subscribers SET ical_token = uuid_generate_v4() WHERE ical_token IS NULL;
COMMIT;
