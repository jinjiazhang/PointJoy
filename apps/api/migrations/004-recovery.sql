CREATE TABLE recovery_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),operator text NOT NULL,
 status text NOT NULL CHECK(status IN ('RUNNING','READY','HOLD','FAILED')),
 report jsonb NOT NULL DEFAULT '{}',started_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz
);
CREATE TABLE recovery_file_cleanup (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES recovery_runs(id),
 storage text NOT NULL CHECK(storage IN ('MEDIA','EXPORT')),object_key text NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE')),
 last_error text,completed_at timestamptz,UNIQUE(run_id,storage,object_key)
);
CREATE INDEX recovery_cleanup_pending ON recovery_file_cleanup(status,run_id);
