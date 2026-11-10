-- Open tracking of the emails (docs/email-aperture.md): one row per tracked email, the id is
-- the token of its 1x1 image (GET /i/<id>.gif). Only the first open, and only a label of the
-- app (via); no IP, no device. Kept 6 months (the notifier prunes it).
-- Idempotent: safe to run more than once. Additive only.
BEGIN;

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

COMMIT;
