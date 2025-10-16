-- 001_print_jobs.sql
CREATE TABLE IF NOT EXISTS print_jobs (
                                          id           SERIAL PRIMARY KEY,
                                          image_id     INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'queued',       -- queued | printing | done | error
    copies       INTEGER NOT NULL DEFAULT 1,
    media        TEXT NOT NULL DEFAULT 'Letter',       -- Letter | A4 | etc.
    requester_ip INET,
    worker_id    TEXT,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ
    );

-- helps oldest-first dequeue
CREATE INDEX IF NOT EXISTS print_jobs_status_created_idx
    ON print_jobs(status, created_at);

-- prevent dup clicks while job is in-flight
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_once_per_image_inflight
    ON print_jobs(image_id)
    WHERE status IN ('queued','printing');
