-- Promo to students who are not subscribed (promo/, list from the teachers): their emails are
-- tracked too, with no subscriber row. A row has a subscriber or an email.
ALTER TABLE public.email_sends ALTER COLUMN sub_id DROP NOT NULL;
ALTER TABLE public.email_sends ADD COLUMN IF NOT EXISTS email text; -- only when sub_id is NULL
DO $$ BEGIN
  ALTER TABLE public.email_sends ADD CONSTRAINT email_sends_recipient CHECK (sub_id IS NOT NULL OR email IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS email_sends_email ON public.email_sends (lower(email)) WHERE email IS NOT NULL;
