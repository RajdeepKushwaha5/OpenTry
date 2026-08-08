-- OpenTry lease store.
--
-- One row per trial project that has ever existed. Rows are never deleted:
-- the reaper needs a durable record of every project id it created so it can
-- prove ownership before destroying anything, and the audit trail is the only
-- defence if a delete ever goes wrong.

CREATE TABLE IF NOT EXISTS leases (
  id              TEXT PRIMARY KEY,              -- trialId, also embedded in the project tag
  app_slug        TEXT NOT NULL,
  state           TEXT NOT NULL,

  -- Zerops identity. project_id is written the moment the import returns, so
  -- a crash mid-provision still leaves us able to find and destroy the project.
  project_id      TEXT,
  project_name    TEXT,
  url             TEXT,
  credentials     JSONB NOT NULL DEFAULT '[]'::jsonb,
  services        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Lifecycle timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at        TIMESTAMPTZ,
  claimed_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  destroyed_at    TIMESTAMPTZ,

  -- Who claimed it (a hashed visitor fingerprint, never a raw IP)
  visitor_hash    TEXT,

  ttl_minutes     INTEGER NOT NULL,
  provision_ms    INTEGER,
  estimated_cost  NUMERIC(10, 6),
  error           TEXT
);

-- The warm-pool claim query. Partial index so the hot path stays tiny even
-- once the table has thousands of historical rows.
CREATE INDEX IF NOT EXISTS leases_claimable
  ON leases (app_slug, ready_at)
  WHERE state = 'READY_UNCLAIMED';

-- The reaper's sweep.
CREATE INDEX IF NOT EXISTS leases_reapable
  ON leases (expires_at)
  WHERE state IN ('CLAIMED', 'READY_UNCLAIMED', 'PROVISIONING');

-- Enforces "one active trial per visitor" without a separate table.
CREATE INDEX IF NOT EXISTS leases_visitor
  ON leases (visitor_hash)
  WHERE state = 'CLAIMED';

CREATE INDEX IF NOT EXISTS leases_project_id ON leases (project_id);

-- Append-only provisioning timeline. The browser replays these over SSE, and
-- they are what makes a 5-minute provision watchable instead of a dead spinner.
CREATE TABLE IF NOT EXISTS lease_events (
  id         BIGSERIAL PRIMARY KEY,
  lease_id   TEXT NOT NULL REFERENCES leases (id) ON DELETE CASCADE,
  at_ms      INTEGER NOT NULL,
  step       TEXT NOT NULL,
  status     TEXT NOT NULL,
  message    TEXT NOT NULL,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lease_events_lease ON lease_events (lease_id, id);
