/**
 * The database schema as it stood at commit d09de27 — the last canonical `main`
 * before execution epochs and manual-X ingest.
 *
 * Frozen here on purpose. The upgrade test needs a database built the way the
 * OLD code really built one, and reconstructing that from the current schema
 * would test the current schema against itself and prove nothing. This is a
 * verbatim copy; it must never be "kept in sync" with the live schema.
 */
export const SCHEMA_V2_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ------------------------------------------------------------- securities
CREATE TABLE IF NOT EXISTS securities (
  security_id        TEXT PRIMARY KEY,
  ticker             TEXT NOT NULL,
  company_name       TEXT NOT NULL,
  aliases_json       TEXT NOT NULL DEFAULT '[]',
  exchange           TEXT NOT NULL,
  asset_class        TEXT NOT NULL DEFAULT 'US_EQUITY',
  alpaca_tradable    INTEGER NOT NULL DEFAULT 1,
  alpaca_fractionable INTEGER NOT NULL DEFAULT 1,
  universe_sources_json TEXT NOT NULL DEFAULT '[]',
  active             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_securities_ticker ON securities(ticker);

-- ---------------------------------------------------------------- sources
CREATE TABLE IF NOT EXISTS social_authors (
  author_id             TEXT PRIMARY KEY,
  handle                TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  verified              INTEGER NOT NULL DEFAULT 0,
  follower_count        INTEGER NOT NULL DEFAULT 0,
  account_created_at    TEXT,
  source_class          TEXT NOT NULL,
  source_tier           TEXT NOT NULL,
  official_for_security_id TEXT,
  baseline_engagement   REAL NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_authors_handle ON social_authors(lower(handle));

-- ---------------------------------------------------------- social events
CREATE TABLE IF NOT EXISTS social_events (
  event_id             TEXT PRIMARY KEY,
  platform             TEXT NOT NULL,
  post_id              TEXT NOT NULL UNIQUE,
  author_id            TEXT NOT NULL,
  author_handle        TEXT NOT NULL,
  author_display_name  TEXT NOT NULL,
  source_class         TEXT NOT NULL,
  source_tier          TEXT NOT NULL,
  posted_at            TEXT NOT NULL,
  captured_at          TEXT NOT NULL,
  text                 TEXT NOT NULL,
  url                  TEXT NOT NULL,
  lang                 TEXT,
  kind                 TEXT NOT NULL,
  referenced_post_id   TEXT,
  mentioned_cashtags_json  TEXT NOT NULL DEFAULT '[]',
  mentioned_companies_json TEXT NOT NULL DEFAULT '[]',
  resolved_security_ids_json TEXT NOT NULL DEFAULT '[]',
  engagement_json      TEXT NOT NULL DEFAULT '{}',
  author_baseline_engagement REAL,
  ingest_batch_id      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_posted_at ON social_events(posted_at);
CREATE INDEX IF NOT EXISTS idx_events_batch ON social_events(ingest_batch_id);
CREATE INDEX IF NOT EXISTS idx_events_author ON social_events(author_id);

CREATE TABLE IF NOT EXISTS filter_results (
  event_id    TEXT PRIMARY KEY REFERENCES social_events(event_id),
  verdict     TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  weight      REAL NOT NULL,
  dedup_key   TEXT NOT NULL,
  notes_json  TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filter_dedup ON filter_results(dedup_key);

CREATE TABLE IF NOT EXISTS ticker_resolutions (
  resolution_id TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES social_events(event_id),
  security_id   TEXT NOT NULL,
  ticker        TEXT NOT NULL,
  method        TEXT NOT NULL,
  confidence    REAL NOT NULL,
  matched_text  TEXT NOT NULL,
  competing_security_ids_json TEXT NOT NULL DEFAULT '[]',
  notes_json    TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  UNIQUE(event_id, security_id)
);
CREATE INDEX IF NOT EXISTS idx_resolutions_security ON ticker_resolutions(security_id);

-- --------------------------------------------------------------- strategy
CREATE TABLE IF NOT EXISTS strategies (
  strategy_id       TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  version           TEXT NOT NULL,
  status            TEXT NOT NULL,
  run_state         TEXT NOT NULL,
  mode              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  allocated_capital_cents INTEGER NOT NULL,
  benchmark_ticker  TEXT NOT NULL,
  universe_sources_json TEXT NOT NULL,
  risk_limits_json  TEXT NOT NULL,
  signal_config_id  TEXT NOT NULL,
  description       TEXT NOT NULL,
  halt_reason       TEXT,
  halted_at         TEXT
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  strategy_id  TEXT NOT NULL,
  version      TEXT NOT NULL,
  published_at TEXT NOT NULL,
  spec_json    TEXT NOT NULL,
  PRIMARY KEY (strategy_id, version)
);

-- ---------------------------------------------------------------- signals
CREATE TABLE IF NOT EXISTS signals (
  signal_id        TEXT PRIMARY KEY,
  strategy_id      TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  security_id      TEXT NOT NULL,
  ticker           TEXT NOT NULL,
  score            REAL NOT NULL,
  band             TEXT NOT NULL,
  uncertainty      REAL NOT NULL,
  generated_at     TEXT NOT NULL,
  components_json  TEXT NOT NULL,
  contributions_json TEXT NOT NULL,
  signal_config_id TEXT NOT NULL,
  triggering_event_ids_json TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  supporting_evidence_json TEXT NOT NULL,
  contradictory_evidence_json TEXT NOT NULL,
  dominant_event_type TEXT NOT NULL,
  price_confirmation_json TEXT,
  explanation      TEXT NOT NULL,
  source_count     INTEGER NOT NULL,
  independent_source_count REAL NOT NULL,
  resolution_confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_generated ON signals(generated_at);
CREATE INDEX IF NOT EXISTS idx_signals_security ON signals(security_id, generated_at);

-- -------------------------------------------------------------- proposals
CREATE TABLE IF NOT EXISTS trade_proposals (
  proposal_id      TEXT PRIMARY KEY,
  strategy_id      TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  signal_id        TEXT NOT NULL REFERENCES signals(signal_id),
  security_id      TEXT NOT NULL,
  ticker           TEXT NOT NULL,
  direction        TEXT NOT NULL,
  side             TEXT NOT NULL,
  proposed_capital_cents INTEGER NOT NULL,
  proposed_quantity REAL NOT NULL,
  fractional       INTEGER NOT NULL,
  reference_price  REAL NOT NULL,
  reference_price_as_of TEXT NOT NULL,
  confidence       REAL NOT NULL,
  rationale        TEXT NOT NULL,
  evidence_summary_json TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  status           TEXT NOT NULL,
  mode             TEXT NOT NULL,
  risk_decision_id TEXT,
  invalidation_condition_json TEXT NOT NULL,
  approval_fingerprint TEXT NOT NULL,
  correlation_id   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON trade_proposals(status, created_at);

CREATE TABLE IF NOT EXISTS risk_decisions (
  risk_decision_id TEXT PRIMARY KEY,
  proposal_id      TEXT NOT NULL REFERENCES trade_proposals(proposal_id),
  strategy_id      TEXT NOT NULL,
  approved         INTEGER NOT NULL,
  checks_json      TEXT NOT NULL,
  failed_checks_json TEXT NOT NULL,
  permitted_capital_cents INTEGER NOT NULL,
  permitted_quantity REAL NOT NULL,
  decided_at       TEXT NOT NULL,
  summary          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_proposal ON risk_decisions(proposal_id);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id  TEXT PRIMARY KEY,
  proposal_id  TEXT NOT NULL REFERENCES trade_proposals(proposal_id),
  decision     TEXT NOT NULL,
  decided_by   TEXT NOT NULL,
  decided_at   TEXT NOT NULL,
  approval_fingerprint TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON approvals(proposal_id);

-- ----------------------------------------------------------------- orders
CREATE TABLE IF NOT EXISTS orders (
  order_id        TEXT PRIMARY KEY,
  broker_order_id TEXT,
  strategy_id     TEXT NOT NULL,
  proposal_id     TEXT,
  position_id     TEXT,
  security_id     TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  side            TEXT NOT NULL,
  quantity        REAL NOT NULL,
  notional_cents  INTEGER,
  type            TEXT NOT NULL,
  time_in_force   TEXT NOT NULL,
  mode            TEXT NOT NULL,
  status          TEXT NOT NULL,
  submitted_at    TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  filled_quantity REAL NOT NULL DEFAULT 0,
  filled_avg_price REAL,
  client_order_id TEXT NOT NULL UNIQUE,
  reject_reason   TEXT,
  intent          TEXT NOT NULL,
  correlation_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_orders_proposal ON orders(proposal_id);

CREATE TABLE IF NOT EXISTS fills (
  fill_id         TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(order_id),
  broker_order_id TEXT,
  security_id     TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  side            TEXT NOT NULL,
  quantity        REAL NOT NULL,
  price           REAL NOT NULL,
  fees_cents      INTEGER NOT NULL DEFAULT 0,
  filled_at       TEXT NOT NULL,
  partial         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);

-- -------------------------------------------------------------- positions
CREATE TABLE IF NOT EXISTS positions (
  position_id      TEXT PRIMARY KEY,
  strategy_id      TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  security_id      TEXT NOT NULL,
  ticker           TEXT NOT NULL,
  direction        TEXT NOT NULL,
  status           TEXT NOT NULL,
  quantity         REAL NOT NULL,
  entry_price      REAL NOT NULL,
  entry_cost_cents INTEGER NOT NULL,
  opened_at        TEXT NOT NULL,
  entry_order_id   TEXT NOT NULL,
  entry_signal_id  TEXT NOT NULL,
  entry_proposal_id TEXT NOT NULL,
  entry_signal_score REAL NOT NULL,
  invalidation_condition_json TEXT NOT NULL,
  high_water_price REAL NOT NULL,
  last_mark_price  REAL NOT NULL,
  last_mark_at     TEXT NOT NULL,
  unrealised_pnl_cents INTEGER NOT NULL DEFAULT 0,
  exit_order_id    TEXT,
  exit_price       REAL,
  exit_proceeds_cents INTEGER,
  closed_at        TEXT,
  exit_reason      TEXT,
  exit_note        TEXT,
  realised_pnl_cents INTEGER,
  fees_cents       INTEGER NOT NULL DEFAULT 0,
  mode             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(strategy_id, status);
CREATE INDEX IF NOT EXISTS idx_positions_security ON positions(strategy_id, security_id, status);

-- ----------------------------------------------------------------- ledger
CREATE TABLE IF NOT EXISTS capital_ledger (
  strategy_id             TEXT PRIMARY KEY,
  starting_capital_cents  INTEGER NOT NULL,
  cash_cents              INTEGER NOT NULL,
  reserved_cents          INTEGER NOT NULL DEFAULT 0,
  positions_value_cents   INTEGER NOT NULL DEFAULT 0,
  unrealised_pnl_cents    INTEGER NOT NULL DEFAULT 0,
  realised_pnl_cents      INTEGER NOT NULL DEFAULT 0,
  fees_paid_cents         INTEGER NOT NULL DEFAULT 0,
  equity_cents            INTEGER NOT NULL,
  high_water_equity_cents INTEGER NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id        TEXT PRIMARY KEY,
  strategy_id     TEXT NOT NULL,
  at              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  cash_after_cents INTEGER NOT NULL,
  reference       TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries ON ledger_entries(strategy_id, at);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  strategy_id   TEXT NOT NULL,
  at            TEXT NOT NULL,
  equity_cents  INTEGER NOT NULL,
  cash_cents    INTEGER NOT NULL,
  positions_value_cents INTEGER NOT NULL,
  benchmark_price REAL,
  UNIQUE(strategy_id, at)
);
CREATE INDEX IF NOT EXISTS idx_equity_at ON equity_snapshots(strategy_id, at);

-- -------------------------------------------------------------- analytics
CREATE TABLE IF NOT EXISTS signal_outcomes (
  outcome_id    TEXT PRIMARY KEY,
  signal_id     TEXT NOT NULL REFERENCES signals(signal_id),
  strategy_id   TEXT NOT NULL,
  security_id   TEXT NOT NULL,
  ticker        TEXT NOT NULL,
  signal_score  REAL NOT NULL,
  band          TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  entry_reference_price REAL NOT NULL,
  horizon       TEXT NOT NULL,
  forward_return_pct REAL,
  benchmark_return_pct REAL,
  excess_return_pct REAL,
  measured_at   TEXT,
  hit           INTEGER,
  UNIQUE(signal_id, horizon)
);
CREATE INDEX IF NOT EXISTS idx_outcomes_pending ON signal_outcomes(measured_at, horizon);

CREATE TABLE IF NOT EXISTS survival_metrics (
  metrics_id       TEXT PRIMARY KEY,
  strategy_id      TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  as_of            TEXT NOT NULL,
  payload_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_survival_asof ON survival_metrics(strategy_id, as_of);

-- ---------------------------------------------------------- decision log
CREATE TABLE IF NOT EXISTS decision_log (
  log_id         TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  strategy_id    TEXT NOT NULL,
  stage          TEXT NOT NULL,
  at             TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  summary        TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_log_correlation ON decision_log(correlation_id, at);
CREATE INDEX IF NOT EXISTS idx_log_stage ON decision_log(strategy_id, stage, at);

-- -------------------------------------------------------------- incidents
CREATE TABLE IF NOT EXISTS health_incidents (
  incident_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  fault       TEXT NOT NULL,
  at          TEXT NOT NULL,
  detail      TEXT NOT NULL,
  paused      INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON health_incidents(strategy_id, resolved_at);

-- ------------------------------------------------------ api telemetry
-- Durable per-day counters, so a restart does not reset today's usage and the
-- morning's request budget is still legible in the afternoon.
CREATE TABLE IF NOT EXISTS api_usage (
  provider        TEXT NOT NULL,
  day             TEXT NOT NULL,
  requests        INTEGER NOT NULL DEFAULT 0,
  successes       INTEGER NOT NULL DEFAULT 0,
  unauthorized    INTEGER NOT NULL DEFAULT 0,
  forbidden       INTEGER NOT NULL DEFAULT 0,
  rate_limited    INTEGER NOT NULL DEFAULT 0,
  timeouts        INTEGER NOT NULL DEFAULT 0,
  server_errors   INTEGER NOT NULL DEFAULT 0,
  other_errors    INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_error_at   TEXT,
  last_error_kind TEXT,
  last_error_detail TEXT,
  rate_limit_remaining INTEGER,
  rate_limit_limit     INTEGER,
  rate_limit_reset_at  TEXT,
  PRIMARY KEY (provider, day)
);

-- Polling cursors: the newest post id seen per query, so each scan asks for
-- what is NEW rather than re-reading the same window.
CREATE TABLE IF NOT EXISTS provider_cursors (
  cursor_key   TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- --------------------------------------------------- market data cache
CREATE TABLE IF NOT EXISTS price_bars (
  ticker TEXT NOT NULL,
  at     TEXT NOT NULL,
  open   REAL NOT NULL,
  high   REAL NOT NULL,
  low    REAL NOT NULL,
  close  REAL NOT NULL,
  volume REAL,
  PRIMARY KEY (ticker, at)
);
`;

export const SCHEMA_V2_VERSION = 2;
