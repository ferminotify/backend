-- Opt-in notification categories (utils/timetable/optIn.js): help desks, peer tutoring,
-- competitions, representatives' meetings listed for a whole year are notified only to
-- users who chose them. Empty = only when the title names their class (as before).
-- Idempotent: safe to run more than once. Additive only (column with a default).
BEGIN;

ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS notify_optin text[] NOT NULL DEFAULT '{}';

COMMIT;
