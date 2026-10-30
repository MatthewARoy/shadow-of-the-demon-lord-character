-- Shared party storage (docs/superpowers/specs/2026-10-29-shared-party-storage-design.md).
-- members: one row per invite. Only the SHA-256 (hex) of each invite token is
-- stored; revoking sets revoked_at and the token stops working.
-- characters: one row per character, owned by the member who created it.
-- rev bumps on every write; deleted_at marks a tombstone (body is kept).
-- Times are epoch milliseconds.

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES members(id),
  rev INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX characters_owner ON characters(owner_id);
