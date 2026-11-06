'use strict';
/* SQLite (better-sqlite3) in WAL mode with a forward-only migration runner.
   Migrations are files named NNN_description.sql in ./migrations, applied in order, each in a transaction. */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((file) => ({ version: Number(file.slice(0, 3)), file }));
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all());
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of listMigrations()) {
    if (applied.has(m.version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(m.version, m.file, new Date().toISOString());
    })();
  }
}

module.exports = { openDatabase, migrate };
