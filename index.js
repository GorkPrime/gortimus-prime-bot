"use strict";

const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");

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

// ===== In-memory UI state (simple + works) =====
const pendingAdd = new Map(); // chatId -> true/false
const pendingCandidate = new Map(); // chatId -> { chainId, pairAddress, symbol, url, priceUsd, liqUsd, vol24h }

// ===== DB setup + safe migrations =====
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      trending INTEGER DEFAULT 0
    )
  `);

  // Base table (may already exist)
  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      pair TEXT
    )
  `);

  // Add columns if missing (ignore errors)
  db.run(`ALTER TABLE watchlist ADD COLUMN chain_id TEXT`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN pair_address TEXT`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN symbol TEXT`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN url TEXT`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN last_price REAL`, () => {});
});

// ===== UI =====
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

function confirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Add Watch", callback_data: "CONFIRM_ADD" }],
      [{ text: "❌ Cancel", callback_data: "CANCEL_ADD" }],
    ],
  };
}

// ===== Helpers =====
function looksLikeSolAddress(s) {
  // Solana base58 is typically 32-44 chars; this is a practical heuristic
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function parseDexLink(text) {
  // https://dexscreener.com/solana/<pairAddress>
  const m = text.match(/dexscreener\.com\/([a-z0-9_-]+)\/([a-zA-Z0-9]+)/i);
  if (!m) return null;
  return { chainId: m[1].toLowerCase(), pairAddress: m[2] };
}

async function dexscreenerSearch(query) {
  // Works for: ticker, mint, pair, address, etc.
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

function pickBestPair(pairs) {
  // Prefer Solana, highest liquidity
  const sol = pairs.filter((p) => (p?.chainId || "").toLowerCase() === "solana");
  const list = sol.length ? sol : pairs;

  const scored = list
    .map((p) => ({
      chainId: (p.chainId || "").toLowerCase(),
      pairAddress: p.pairAddress,
      symbol: p?.baseToken?.symbol || "???",
      url: p.url,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liqUsd: p?.liquidity?.usd ? Number(p.liquidity.usd) : 0,
      vol24h: p?.volume?.h24 ? Number(p.volume.h24) : 0,
    }))
    .filter((x) => x.chainId && x.pairAddress);

  scored.sort((a, b) => (b.liqUsd - a.liqUsd) || (b.vol24h - a.vol24h));
  return scored[0] || null;
}

function fmtMoney(n) {
  if (n === null || n === undefined) return "n/a";
  const num = Number(n);
  if (!Number.isFinite(num)) return "n/a";
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${Math.round(num).toLocaleString()}`;
  return `$${num}`;
}

// ===== /start =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  db.run("INSERT OR IGNORE INTO users(chat_id) VALUES (?)", [chatId]);

  bot.sendMessage(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nSelect command below.", {
    reply_markup: menu(),
  });
});

// ===== Optional: /watch command =====
bot.onText(/\/watch (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const q = (match?.[1] || "").trim();
  if (!q) return;

  pendingAdd.set(chatId, true);
  await handleWatchQuery(chatId, q);
});

// ===== Buttons =====
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  bot.answerCallbackQuery(query.id).catch(() => null);

  if (action === "WATCH") {
    pendingAdd.set(chatId, true);
    pendingCandidate.delete(chatId);

    bot.sendMessage(
      chatId,
      "Send **ticker** (ex: BONK), **coin address**, or **DexScreener link**.\n\nI’ll find it and you tap ✅ Add Watch.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "CANCEL_ADD") {
    pendingAdd.delete(chatId);
    pendingCandidate.delete(chatId);
    bot.sendMessage(chatId, "Cancelled.");
    return;
  }

  if (action === "CONFIRM_ADD") {
    const cand = pendingCandidate.get(chatId);
    if (!cand) {
      bot.sendMessage(chatId, "Nothing to add. Tap 👁 Add Watch again.");
      return;
    }

    // Persist
    db.run(
      `INSERT OR IGNORE INTO watchlist(chat_id, pair, chain_id, pair_address, symbol, url, last_price)
       VALUES(?,?,?,?,?,?,?)`,
      [
        chatId,
        cand.url || `${cand.chainId}/${cand.pairAddress}`,
        cand.chainId,
        cand.pairAddress,
        cand.symbol,
        cand.url,
        cand.priceUsd,
      ],
      (err) => {
        if (err) {
          bot.sendMessage(chatId, "DB error adding watch.");
          return;
        }
        pendingAdd.delete(chatId);
        pendingCandidate.delete(chatId);
        bot.sendMessage(chatId, `✅ Watching: ${cand.symbol}\n${cand.url || `${cand.chainId}/${cand.pairAddress}`}`);
      }
    );
    return;
  }

  if (action === "LIST") {
    db.all(
      `SELECT COALESCE(symbol,'???') AS symbol,
              COALESCE(url, pair, '') AS link,
              COALESCE(chain_id,'') AS chain_id,
              COALESCE(pair_address,'') AS pair_address,
              last_price
       FROM watchlist
       WHERE chat_id = ?
       ORDER BY id DESC
       LIMIT 50`,
      [chatId],
      (err, rows) => {
        if (err) return bot.sendMessage(chatId, "DB error reading watchlist.");
        if (!rows || rows.length === 0) return bot.sendMessage(chatId, "Watchlist empty.");

        const text = rows
          .map((r, i) => {
            const price = r.last_price ? ` | $${r.last_price}` : "";
            const ref = r.link || (r.chain_id && r.pair_address ? `${r.chain_id}/${r.pair_address}` : "");
            return `${i + 1}) ${r.symbol}${price}\n${ref}`;
          })
          .join("\n\n");

        bot.sendMessage(chatId, "👁 Watchlist:\n\n" + text);
      }
    );
    return;
  }

  if (action === "TRENDING") {
    bot.sendMessage(chatId, "🔥 Trending toggles & alerts come next (after watch alerts).");
    return;
  }

  if (action === "STATUS") {
    bot.sendMessage(chatId, "🟢 Online\n✅ Polling OK\n✅ SQLite OK\n✅ Easy Add (ticker/address/link) enabled");
    return;
  }
});

// ===== Core: Handle user text input for watch =====
async function handleWatchQuery(chatId, input) {
  try {
    let q = input.trim();

    // If Dex link, extract pairAddress and search using that
    const dex = parseDexLink(q);
    if (dex) q = dex.pairAddress;

    // If they paste a SOL address, search it
    // (works for mint or pair; DexScreener search usually returns pairs either way)
    if (looksLikeSolAddress(q)) {
      // keep as-is
    } else {
      // ticker or any text: keep as-is
    }

    const pairs = await dexscreenerSearch(q);
    const best = pickBestPair(pairs);

    if (!best) {
      pendingCandidate.delete(chatId);
      bot.sendMessage(chatId, "Couldn’t find that. Try ticker, mint address, or a DexScreener link.");
      return;
    }

    pendingCandidate.set(chatId, best);

    const msg =
      `Found this:\n\n` +
      `🪙 ${best.symbol}\n` +
      `Price: ${best.priceUsd !== null ? `$${best.priceUsd}` : "n/a"}\n` +
      `Liquidity: ${fmtMoney(best.liqUsd)}\n` +
      `Vol 24h: ${fmtMoney(best.vol24h)}\n\n` +
      `${best.url || `${best.chainId}/${best.pairAddress}`}\n\n` +
      `Tap ✅ Add Watch to save it.`;

    bot.sendMessage(chatId, msg, { reply_markup: confirmKeyboard() });
  } catch (e) {
    pendingCandidate.delete(chatId);
    bot.sendMessage(chatId, "DexScreener lookup failed (API). Try again in a sec.");
  }
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  if (text.startsWith("/")) return;

  // Only treat message as “add watch” input if user tapped Add Watch,
  // OR if it obviously looks like a dex link or address.
  const shouldHandle =
    pendingAdd.get(chatId) === true ||
    text.includes("dexscreener.com") ||
    looksLikeSolAddress(text);

  if (!shouldHandle) return;

  // Clear pending flag after 1 attempt (so normal chat doesn't keep triggering)
  pendingAdd.delete(chatId);

  await handleWatchQuery(chatId, text);
});

// ===== Log errors =====
bot.on("polling_error", (err) => {
  console.error("❌ polling_error:", err?.message || err);
});

console.log("🛡️ Gorktimus bot running (easy add enabled)");
