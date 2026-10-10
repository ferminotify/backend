-- When each AI reading was last needed (its title still on the calendar), so readings of
-- titles gone from the calendar can be deleted (utils/timetable/ai.js, daily cleanup).
-- Idempotent: safe to run more than once.
BEGIN;

ALTER TABLE public.timetable_ai_readings
  ADD COLUMN IF NOT EXISTS last_seen timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS timetable_ai_readings_last_seen_idx
  ON public.timetable_ai_readings (last_seen);

COMMIT;
