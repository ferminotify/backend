-- Production release of feat/cercaeventi_calendar_api: every migration since the last deploy,
-- in one file. Idempotent: safe to run more than once and on a DB where some parts already
-- ran (on 2026-11-02 production already had google-oauth, moodle-login and notify-optin).
-- Additive only: no data removed. Single transaction: all or nothing.
--
-- Includes, in order:
--   2026-06-07-google-oauth.sql
--   2026-10-13-moodle-login.sql
--   2026-10-17-notify-optin.sql   + default opt-in categories (below)
--   2026-10-28-school-ticket.sql
--   2026-10-30-email-sends.sql
--   2026-11-01-email-inactive.sql
-- Then, separately (needs the password): psql -v pw="$MB_RO_PASSWORD" -f staging/metabase/grants.sql
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026-11-02-prod-release.sql
BEGIN;

-- 2026-06-07-google-oauth.sql: Google login (accounts without a password)
ALTER TABLE public.subscribers ALTER COLUMN password DROP NOT NULL;
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS google_id varchar(40) UNIQUE;
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS profile_complete boolean DEFAULT true;

-- 2026-10-13-moodle-login.sql: Moodle username of the account
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS school_username varchar(150) UNIQUE;

-- 2026-10-17-notify-optin.sql: opt-in categories (backend utils/timetable/match.js, OPT_IN)
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS notify_optin text[] NOT NULL DEFAULT '{}';

-- On by default: gruppo, olimpiadi, rappresentanti (sportelli, tutoring: off), for new and existing accounts. Keep the list in
-- sync with OPT_IN. The existing accounts are switched on only the first time (while the
-- column default is still empty): a re-run must not turn back on what a user turned off.
DO $$
BEGIN
    IF (SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'subscribers' AND column_name = 'notify_optin')
       = '''{}''::text[]' THEN
        UPDATE public.subscribers
           SET notify_optin = ARRAY['gruppo', 'olimpiadi', 'rappresentanti']
         WHERE notify_optin = '{}';
    END IF;
END $$;
ALTER TABLE public.subscribers
    ALTER COLUMN notify_optin SET DEFAULT ARRAY['gruppo', 'olimpiadi', 'rappresentanti']::text[];

-- 2026-10-28-school-ticket.sql: last Moodle session, sealed (utils/schoolTicket.js)
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS school_ticket text;

-- 2026-10-30-email-sends.sql: one row per tracked email; id = the open pixel's token
CREATE TABLE IF NOT EXISTS public.email_sends (
    id         uuid        PRIMARY KEY,
    sub_id     bigint      NOT NULL REFERENCES public.subscribers(id) ON DELETE CASCADE,
    kind       text        NOT NULL,             -- 'daily' | 'lastminute' | 'promo-*'
    sent_at    timestamptz NOT NULL DEFAULT now(),
    opened_at  timestamptz,                      -- first open; NULL = not (yet) opened
    via        text                              -- 'gmail' | 'apple' | 'altro'
);
CREATE INDEX IF NOT EXISTS email_sends_sent_at ON public.email_sends (sent_at);
CREATE INDEX IF NOT EXISTS email_sends_sub     ON public.email_sends (sub_id, sent_at);

-- 2026-11-01-email-inactive.sql: dead mailboxes and the providers' rejections
ALTER TABLE public.subscribers
    ADD COLUMN IF NOT EXISTS email_inactive_at     timestamptz,  -- NULL = mailbox working
    ADD COLUMN IF NOT EXISTS email_inactive_reason text;         -- provider: server reply
CREATE TABLE IF NOT EXISTS public.email_bounces (
    id        bigserial   PRIMARY KEY,
    sub_id    bigint      NOT NULL REFERENCES public.subscribers(id) ON DELETE CASCADE,
    email     text        NOT NULL,
    provider  text        NOT NULL,   -- 'azure' | 'mailgun'
    status    text        NOT NULL,   -- 'unknown_user' | 'failed' | 'suppressed'
    reason    text,
    at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_bounces_sub ON public.email_bounces (sub_id, at);

COMMIT;
