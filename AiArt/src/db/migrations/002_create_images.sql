CREATE TABLE IF NOT EXISTS images (
    id         SERIAL PRIMARY KEY,
    prompt     TEXT         NOT NULL,
    gcs_path   TEXT         NOT NULL,
    model      VARCHAR(128) NOT NULL,
    parent_id  INTEGER REFERENCES images(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id)  ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
