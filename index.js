const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

const token = process.env.TELEGRAM_BOT_TOKEN;

const bot = new TelegramBot(token, { polling: true });

const db = new sqlite3.Database('./gorktimus.db');

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
      chat_id INTEGER,
      pair TEXT
    )
  `);
});

function menu() {
  return {
    inline_keyboard: [
      [{ text: "🔥 Trending", callback_data: "TRENDING" }],
      [{ text: "👁 Add Watch", callback_data: "WATCH" }],
      [{ text: "📋 Watchlist", callback_data: "LIST" }]
    ]
  };
}

bot.onText(/\/start/, (msg) => {

  const chatId = msg.chat.id;

  db.run("INSERT OR IGNORE INTO users(chat_id) VALUES (?)", [chatId]);

  bot.sendMessage(chatId,
    "🛡️ GORKTIMUS PRIME TERMINAL\n\nSelect option below.",
    { reply_markup: menu() }
  );

});

bot.on("callback_query", (query) => {

  const chatId = query.message.chat.id;

  if (query.data === "WATCH") {
    bot.sendMessage(chatId, "Paste Dexscreener link.");
  }

  if (query.data === "LIST") {

    db.all(
      "SELECT pair FROM watchlist WHERE chat_id=?",
      [chatId],
      (err, rows) => {

        if (!rows.length) {
          bot.sendMessage(chatId, "Watchlist empty.");
          return;
        }

        const list = rows.map(r => r.pair).join("\n");

        bot.sendMessage(chatId, "Watchlist:\n\n" + list);

      }
    );
  }

  if (query.data === "TRENDING") {
    bot.sendMessage(chatId, "Trending feature coming soon.");
  }

});

bot.on("message", (msg) => {

  const chatId = msg.chat.id;

  if (!msg.text) return;

  if (msg.text.includes("dexscreener.com")) {

    db.run(
      "INSERT INTO watchlist(chat_id,pair) VALUES(?,?)",
      [chatId, msg.text]
    );

    bot.sendMessage(chatId, "Added to watchlist.");

  }

});

console.log("Gorktimus bot running");
