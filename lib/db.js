'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'druckwunsch.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  column_key TEXT NOT NULL DEFAULT 'wishes',
  position REAL NOT NULL DEFAULT 0,
  due_date TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  moved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#64748b'
);
CREATE TABLE IF NOT EXISTS card_tags (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, tag_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_col ON cards(column_key, position);
CREATE INDEX IF NOT EXISTS idx_links_card ON links(card_id);
CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id);
`);

// ---- Migrationen für bestehende Datenbanken ----
const cardCols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
if (!cardCols.includes('assigned_to')) {
  db.exec('ALTER TABLE cards ADD COLUMN assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_cards_assignee ON cards(assigned_to)');
if (!cardCols.includes('cover_file')) {
  db.exec('ALTER TABLE cards ADD COLUMN cover_file TEXT');
  db.exec('ALTER TABLE cards ADD COLUMN cover_type TEXT');
}
if (!cardCols.includes('is_private')) {
  db.exec('ALTER TABLE cards ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
}
db.exec(`
CREATE TABLE IF NOT EXISTS previews (
  url TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT,
  image_hash TEXT,
  image_type TEXT,
  error TEXT,
  fetched_at TEXT
);`);

// Standard-Tags beim allerersten Start
if (db.prepare('SELECT COUNT(*) AS n FROM tags').get().n === 0) {
  const ins = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)');
  for (const [n, c] of [
    ['Geschenk', '#e11d48'],
    ['Haushalt', '#0891b2'],
    ['Spielzeug', '#f59e0b'],
    ['Ersatzteil', '#64748b'],
    ['Deko', '#a855f7'],
    ['Dringend', '#dc2626'],
  ]) ins.run(n, c);
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx, DATA_DIR };
