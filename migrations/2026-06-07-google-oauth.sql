-- Google OAuth support for subscribers.
-- Idempotent: safe to run more than once.
BEGIN;

-- Google-only accounts have no password.
ALTER TABLE public.subscribers ALTER COLUMN password DROP NOT NULL;

-- Stable Google account id (the OIDC "sub" claim).
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS google_id varchar(40) UNIQUE;

-- New Google signups need a completion step (gender). Existing rows are complete.
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS profile_complete boolean DEFAULT true;

COMMIT;
