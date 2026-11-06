-- Last Moodle login's school session, sealed (utils/schoolTicket.js): the account's other
-- logins reuse it for the teachers on /orario while it is valid.
-- Idempotent: safe to run more than once. Additive only (nullable column).
BEGIN;

ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS school_ticket text;

COMMIT;
