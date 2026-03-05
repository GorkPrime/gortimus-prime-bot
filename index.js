"use strict";

const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();

const token =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TOKEN;

if (!token) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN (or BOT_TOKEN/TOKEN)");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const db = new sqlite3.Database("./gorktimus.db");

// --- DB setup ---
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      trending INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      pair TEXT NOT NULL
    )
  `);
});

// --- UI ---
function menu() {
  return {
    inline_keyboard: [
      [{ text: "🔥 Trending Toggle", callback_data: "TRENDING" }],
      [
        { text: "👁 Add Watch", callback_data: "WATCH" },
        { text: "📋 Watchlist", callback_data: "LIST" },
      ],
      [{ text: "ℹ️ Status", callback_data: "STATUS" }],
    ],
  };
}

// --- /start ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  // Save user
  db.run("INSERT OR IGNORE INTO users(chat_id) VALUES (?)", [chatId]);

  bot.sendMessage(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nSelect command below.", {
    reply_markup: menu(),
  });
});

// --- buttons ---
bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  // stop the “loading” spinner on buttons
  bot.answerCallbackQuery(query.id).catch(() => null);

  if (action === "WATCH") {
    bot.sendMessage(
      chatId,
      "Paste DexScreener pair link.\nExample:\nhttps://dexscreener.com/solana/PAIRADDRESS"
    );
    return;
  }

  if (action === "LIST") {
    db.all("SELECT pair FROM watchlist WHERE chat_id = ? ORDER BY id DESC", [chatId], (err, rows) => {
      if (err) return bot.sendMessage(chatId, "DB error reading watchlist.");
      if (!rows || rows.length === 0) return bot.sendMessage(chatId, "Watchlist empty.");

      const list = rows.map((r, i) => `${i + 1}) ${r.pair}`).join("\n");
      bot.sendMessage(chatId, "👁 Watchlist:\n\n" + list);
    });
    return;
  }

  if (action === "TRENDING") {
    // just a placeholder for now
    bot.sendMessage(chatId, "🔥 Trending toggles & alerts come next.");
    return;
  }

  if (action === "STATUS") {
    bot.sendMessage(chatId, "🟢 Gorktimus Online\n✅ SQLite ready\n✅ Buttons working");
    return;
  }
});

// --- text handler: save DexScreener links ---
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  if (text.startsWith("/")) return;

  if (text.includes("dexscreener.com")) {
    db.run("INSERT INTO watchlist(chat_id, pair) VALUES (?, ?)", [chatId, text], (err) => {
      if (err) return bot.sendMessage(chatId, "Could not add (DB error).");
      bot.sendMessage(chatId, "✅ Added to watchlist.");
    });
  }
});

// --- log polling errors ---
bot.on("polling_error", (err) => {
  console.error("❌ polling_error:", err?.message || err);
});

console.log("🛡️ Gorktimus bot running");
