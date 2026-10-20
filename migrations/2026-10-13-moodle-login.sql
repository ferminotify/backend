-- "Accedi con Moodle": accounts tied to a school (Moodle) username.
-- Idempotent: safe to run more than once. Additive only (nullable column).
BEGIN;

-- School username as typed (matched case-insensitively); NULL for password/Google accounts.
ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS school_username varchar(150) UNIQUE;

COMMIT;
