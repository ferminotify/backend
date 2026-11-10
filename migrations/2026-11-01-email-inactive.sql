-- Dead mailboxes (docs/email-caselle-morte.md): the providers' rejections, and the mailboxes
-- that no longer exist, to stop emailing them (Telegram and push go on).
-- Idempotent: safe to run more than once. Additive only. Needs 2026-10-30-email-sends.sql.
BEGIN;

ALTER TABLE public.subscribers
    ADD COLUMN IF NOT EXISTS email_inactive_at     timestamptz,  -- NULL = mailbox working
    ADD COLUMN IF NOT EXISTS email_inactive_reason text;         -- provider: server reply

-- Every rejection; only 'unknown_user' (mailbox deleted) turns the email off.
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
-- Then staging/metabase/grants.sql, for the new table and columns.
