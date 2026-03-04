const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./gorktimus.db");

// USERS TABLE
db.run(`
CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER PRIMARY KEY,
  trending INTEGER DEFAULT 0
)
`);

// WATCHLIST TABLE
db.run(`
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  token TEXT,
  price REAL
)
`);

module.exports = db;
