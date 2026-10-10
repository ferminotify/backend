-- AI readings of timetable event titles (utils/timetable/ai.js): each title is sent to the
-- AI once per prompt version; the answer is kept here so restarts and deploys reuse it.
-- Idempotent: safe to run more than once.
BEGIN;

CREATE TABLE IF NOT EXISTS public.timetable_ai_readings (
  summary        text        NOT NULL,           -- event title, as in the calendar
  prompt_version smallint    NOT NULL,           -- PROMPT_VERSION in ai.js; bumped → titles re-read
  model          varchar(80) NOT NULL,           -- model that answered
  result         jsonb       NOT NULL,           -- validated reading (classes, room, kind, …)
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (summary, prompt_version)
);

-- Today's AI usage (daily budget) is counted from recent rows.
CREATE INDEX IF NOT EXISTS timetable_ai_readings_created_at_idx ON public.timetable_ai_readings (created_at);

COMMIT;
