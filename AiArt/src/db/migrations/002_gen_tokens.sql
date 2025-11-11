-- 002_gen_tokens.sql
-- A tiny token table to cap global concurrent generations across all PM2 workers.

CREATE TABLE IF NOT EXISTS gen_tokens (
  id        integer PRIMARY KEY,
  in_use    boolean NOT NULL DEFAULT false,
  taken_by  text,
  taken_at  timestamptz
);

-- Seed N tokens (edit the 1..N range to your desired global concurrency, e.g., 3)
INSERT INTO gen_tokens (id)
SELECT i
FROM generate_series(1, 3) AS s(i)
ON CONFLICT (id) DO NOTHING;

-- Helpful view of stuck tokens (> 2 minutes)
-- SELECT * FROM gen_tokens WHERE in_use = true AND taken_at < now() - interval '2 minutes';
