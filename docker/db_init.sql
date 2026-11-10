-- Schema fedele alla struttura di produzione
-- Generato da pg_dump --schema-only sul DB Azure di produzione

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── subscribers ───────────────────────────────────────────────────────────────

CREATE TABLE public.subscribers (
    id                       bigserial PRIMARY KEY,
    name                     character varying(50)  NOT NULL,
    surname                  character varying(50)  NOT NULL,
    email                    character varying(50)  NOT NULL UNIQUE,
    password                 character varying(120),
    telegram                 character varying(50)  UNIQUE,
    tags                     text[],
    notifications            smallint,
    gender                   character varying,
    notification_preferences smallint,
    secret_temp              character varying(20),
    secret_temp_timestamp    timestamp with time zone,
    notification_day_before  boolean                DEFAULT false,
    notification_time        time without time zone DEFAULT '06:00:00',
    unsub_token              uuid                   DEFAULT uuid_generate_v4() UNIQUE,
    temp_sent                boolean                DEFAULT true,
    temp_dash_orario         boolean                DEFAULT false,
    include_similar_tags     boolean                DEFAULT true,
    last_login               timestamp without time zone,
    onboarding               boolean                DEFAULT false,
    google_id                character varying(40)  UNIQUE,
    profile_complete         boolean                DEFAULT true,
    school_username          character varying(150) UNIQUE,
    notify_optin             text[]                 NOT NULL DEFAULT ARRAY['gruppo', 'olimpiadi', 'rappresentanti']::text[], -- OPT_IN (match.js) minus sportelli and tutoring, off by default
    school_ticket            text,
    email_inactive_at        timestamptz,
    email_inactive_reason    text
);

-- ── refresh_tokens ────────────────────────────────────────────────────────────

CREATE TABLE public.refresh_tokens (
    id         serial PRIMARY KEY,
    sub_id     integer REFERENCES public.subscribers(id) ON DELETE CASCADE,
    token      text    NOT NULL UNIQUE,
    expires_at timestamp without time zone NOT NULL
);

-- ── push ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.push (
    id                           serial PRIMARY KEY,
    sub_id                       integer NOT NULL REFERENCES public.subscribers(id) ON DELETE CASCADE,
    device_id                    text    NOT NULL,
    device_info                  text    NOT NULL,
    endpoint                     text    NOT NULL UNIQUE,
    p256dh                       text    NOT NULL,
    auth                         text    NOT NULL,
    created_at                   timestamp with time zone DEFAULT now(),
    send_push_with_notifications boolean DEFAULT false,
    UNIQUE (sub_id, device_id)
);

-- ── sent (notifiche email/telegram già inviate) ───────────────────────────────

CREATE TABLE public.sent (
    sub_id integer          NOT NULL REFERENCES public.subscribers(id),
    uid    character varying NOT NULL,
    PRIMARY KEY (sub_id, uid)
);

-- ── push_sent (push già inviate, tracciato per device) ────────────────────────

CREATE TABLE public.push_sent (
    sub_id    integer          NOT NULL REFERENCES public.subscribers(id) ON DELETE CASCADE,
    uid       character varying NOT NULL,
    device_id text             NOT NULL
);

-- ── stuff (config key/value) ──────────────────────────────────────────────────

CREATE TABLE public.stuff (
    key   character varying(15)  NOT NULL PRIMARY KEY,
    value character varying(100) NOT NULL
);
INSERT INTO public.stuff (key, value) VALUES ('telegram_offset', '');

-- ── classes (fuzzy matching keyword) ─────────────────────────────────────────

CREATE TABLE public.classes (
    id   serial PRIMARY KEY,
    name text NOT NULL
);
CREATE INDEX idx_classes_name_trgm ON public.classes USING gin (name gin_trgm_ops);

INSERT INTO public.classes (name) VALUES
  ('1A'),('1B'),('1C'),('1D'),('1E'),
  ('2A'),('2B'),('2C'),('2D'),('2E'),
  ('3A'),('3B'),('3C'),('3D'),('3E'),
  ('4A'),('4B'),('4C'),('4D'),('4E'),
  ('5A'),('5B'),('5C'),('5D'),('5E'),
  ('1CIIN'),('2CIIN'),('3CIIN'),('4CIIN'),('5CIIN');

-- ── log tables ────────────────────────────────────────────────────────────────

CREATE TABLE public.logs_notifier (
    "timestamp" timestamp with time zone DEFAULT (now() AT TIME ZONE 'Europe/Rome') NOT NULL,
    type        character varying(50) NOT NULL,
    message     text
);

CREATE TABLE public.logs_backup_notifier (
    "timestamp" timestamp with time zone DEFAULT (now() AT TIME ZONE 'Europe/Rome') NOT NULL,
    type        character varying(50) NOT NULL,
    message     text
);

CREATE TABLE public.logs_webapp (
    "timestamp" timestamp with time zone DEFAULT (now() AT TIME ZONE 'Europe/Rome') NOT NULL,
    type        character varying(50) NOT NULL,
    message     text
);

-- ── analytics ─────────────────────────────────────────────────────────────────

CREATE TABLE public.webapp_stats (
    "timestamp" timestamp with time zone DEFAULT (now() AT TIME ZONE 'Europe/Rome') NOT NULL,
    domain      character varying NOT NULL
);

CREATE TABLE public.filtra_eventi_kw (
    keyword     character varying,
    "timestamp" timestamp with time zone DEFAULT now(),
    email       character varying
);

-- ── email_sends / email_bounces (migrations 2026-10-30, 2026-11-01) ───────────

CREATE TABLE public.email_sends (
    id         uuid        PRIMARY KEY,
    sub_id     bigint      NOT NULL REFERENCES public.subscribers(id) ON DELETE CASCADE,
    kind       text        NOT NULL,
    sent_at    timestamptz NOT NULL DEFAULT now(),
    opened_at  timestamptz,
    via        text
);
CREATE INDEX email_sends_sent_at ON public.email_sends (sent_at);
CREATE INDEX email_sends_sub     ON public.email_sends (sub_id, sent_at);

CREATE TABLE public.email_bounces (
    id        bigserial   PRIMARY KEY,
    sub_id    bigint      NOT NULL REFERENCES public.subscribers(id) ON DELETE CASCADE,
    email     text        NOT NULL,
    provider  text        NOT NULL,
    status    text        NOT NULL,
    reason    text,
    at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_bounces_sub ON public.email_bounces (sub_id, at);

-- ── trigger last_login (presente in produzione) ───────────────────────────────

CREATE FUNCTION public.update_last_login() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    NEW.last_login = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

-- ── seed: utente di test ──────────────────────────────────────────────────────
-- password: "password"  (bcrypt, 10 rounds)

INSERT INTO public.subscribers
    (name, surname, email, password, notifications, telegram, gender, notification_preferences, onboarding)
VALUES
    ('Test', 'User', 'test@example.com',
     '$2a$10$KX5C7cT8OYoXGsR.8WSYd.49/wRHJTe5ZPDqJP1BYEnlAB/ddeLEi',
     0, 'Xtest01', 'M', 2, FALSE);
