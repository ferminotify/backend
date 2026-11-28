-- Small key/value state of the backend that must survive restarts.
-- 'timetable.classes': class keys last seen on the school site (utils/timetable/classesWatch.js),
-- to rebuild the frontend when they change.
CREATE TABLE IF NOT EXISTS public.app_state (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
