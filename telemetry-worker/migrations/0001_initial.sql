PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    account_hash TEXT PRIMARY KEY,
    encrypted_wq_id TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    country TEXT NOT NULL,
    latest_version TEXT NOT NULL,
    latest_version_rank TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installations (
    installation_id TEXT NOT NULL,
    account_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, account_hash),
    FOREIGN KEY (account_hash) REFERENCES accounts(account_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS version_registrations (
    installation_id TEXT NOT NULL,
    account_hash TEXT NOT NULL,
    version TEXT NOT NULL,
    previous_version TEXT,
    reason TEXT NOT NULL CHECK (reason IN ('install', 'update', 'retry')),
    country TEXT NOT NULL,
    first_reported_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, account_hash, version),
    FOREIGN KEY (installation_id, account_hash)
        REFERENCES installations(installation_id, account_hash)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_accounts_country ON accounts(country);
CREATE INDEX IF NOT EXISTS idx_accounts_latest_version ON accounts(latest_version);
CREATE INDEX IF NOT EXISTS idx_accounts_last_seen ON accounts(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_installations_account ON installations(account_hash);
CREATE INDEX IF NOT EXISTS idx_registrations_account ON version_registrations(account_hash);
CREATE INDEX IF NOT EXISTS idx_registrations_reported ON version_registrations(first_reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_registrations_upgrade ON version_registrations(previous_version, version);
