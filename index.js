const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// ================= ENV =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COMMUNITY_X_URL =
  process.env.COMMUNITY_X_URL || "https://x.com/gorktimusprime";
const COMMUNITY_TELEGRAM_URL =
  process.env.COMMUNITY_TELEGRAM_URL || "https://t.me/gorktimusprimezone";

// IMPORTANT:
// This must be the Telegram channel/group username like @gorktimusprimezone
// OR a numeric chat id like -1001234567890
// DO NOT put the invite link here.
const REQUIRED_CHANNEL =
  process.env.REQUIRED_CHANNEL || "@gorktimusprimezone";

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// ================= CONFIG =================
const TERMINAL_IMG = path.join(__dirname, "assets", "gorktimus_terminal.png");
const DB_PATH = path.join(__dirname, "gorktimus.db");

const SUPPORTED_CHAINS = ["solana", "base", "ethereum"];
const PRIME_MIN_LIQ_USD = 30000;
const PRIME_MIN_VOL_USD = 20000;
const PRIME_MIN_AGE_MIN = 30;

const LAUNCH_MIN_LIQ_USD = 5000;
const LAUNCH_MIN_VOL_USD = 1000;

const WALLET_SCAN_INTERVAL_MS = 20000;
const DEX_TIMEOUT_MS = 15000;
const HELIUS_TIMEOUT_MS = 20000;
const TELEGRAM_SEND_RETRY_MS = 900;
const WATCHLIST_SCAN_INTERVAL_MS = 180000;
const WATCHLIST_ALERT_COOLDOWN_SEC = 1800;
const MAX_WATCHLIST_ITEMS = 30;

const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";
const HONEYPOT_API_BASE = "https://api.honeypot.is";

const EVM_CHAIN_IDS = {
  ethereum: 1,
  base: 8453
};

// ================= GLOBALS =================
const db = new sqlite3.Database(DB_PATH);
const pendingAction = new Map();
const currentTokenContext = new Map();
let bot = null;
let walletScanInterval = null;
let watchlistScanInterval = null;
let walletScanRunning = false;
let shuttingDown = false;
let BOT_USERNAME = "";
let heliusCooldownUntil = 0;
const HELIUS_COOLDOWN_MS = 60000;
const HELIUS_CACHE_TTL_MS = 180000;
const heliusLargestAccountsCache = new Map();

// ================= DB HELPERS =================
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {await run(`
  CREATE TABLE IF NOT EXISTS user_activity (
    user_id TEXT,
    ts INTEGER
  )
`);

await run(`
  CREATE TABLE IF NOT EXISTS scan_logs (
    user_id TEXT,
    ts INTEGER
  )
`);
  await run(`
    CREATE TABLE IF NOT EXISTS wallet_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      label_type TEXT NOT NULL,
      nickname TEXT,
      chain_id TEXT DEFAULT 'solana',
      active INTEGER DEFAULT 1,
      alerts_enabled INTEGER DEFAULT 1,
      last_signature TEXT,
      last_seen_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, wallet, label_type)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      chat_id TEXT,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_subscribed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      mode TEXT DEFAULT 'balanced',
      alerts_enabled INTEGER DEFAULT 1,
      launch_alerts INTEGER DEFAULT 1,
      smart_alerts INTEGER DEFAULT 1,
      risk_alerts INTEGER DEFAULT 1,
      whale_alerts INTEGER DEFAULT 1,
      explanation_level TEXT DEFAULT 'deep',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL,
      symbol TEXT,
      pair_address TEXT,
      active INTEGER DEFAULT 1,
      alerts_enabled INTEGER DEFAULT 1,
      added_price REAL DEFAULT 0,
      last_price REAL DEFAULT 0,
      last_liquidity REAL DEFAULT 0,
      last_volume REAL DEFAULT 0,
      last_score INTEGER DEFAULT 0,
      last_alert_ts INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, chain_id, token_address)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS pair_memory (
      memory_key TEXT PRIMARY KEY,
      learned_bias REAL DEFAULT 0,
      positive_events INTEGER DEFAULT 0,
      negative_events INTEGER DEFAULT 0,
      last_outcome TEXT,
      last_price REAL DEFAULT 0,
      last_liquidity REAL DEFAULT 0,
      last_volume REAL DEFAULT 0,
      last_seen_at INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS scan_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      chain_id TEXT,
      token_address TEXT,
      pair_address TEXT,
      symbol TEXT,
      feedback TEXT,
      score_snapshot INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
}

// ================= HELPERS =================
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, num(value)));
}

async function retryOperation(label, fn, options = {}) {
  const {
    attempts = 5,
    baseDelay = 700,
    maxDelay = 9000,
    backoff = 1.8,
    jitter = 200,
    shouldRetry = () => true,
    onRetry = null
  } = options;

  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = shouldRetry(err, attempt);
      if (!retryable || attempt === attempts) break;

      const delay = Math.min(
        maxDelay,
        Math.floor(baseDelay * Math.pow(backoff, attempt - 1))
      ) + Math.floor(Math.random() * jitter);

      if (typeof onRetry === "function") {
        try {
          onRetry(err, attempt, delay);
        } catch (_) {}
      }

      await sleep(delay);
    }
  }

  throw lastErr || new Error(`${label} failed`);
}

function shortUsd(n) {
  const x = num(n);
  if (x >= 1_000_000_000) return `$${(x / 1_000_000_000).toFixed(2)}B`;
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `$${(x / 1_000).toFixed(2)}K`;
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(8)}`;
}

function shortAddr(value, len = 6) {
  const s = String(value || "");
  if (s.length <= len * 2 + 3) return s;
  return `${s.slice(0, len)}...${s.slice(-len)}`;
}

function clip(value, len = 28) {
  const s = String(value || "");
  if (s.length <= len) return s;
  return `${s.slice(0, len - 1)}…`;
}

function toPct(value, digits = 2) {
  return `${num(value).toFixed(digits)}%`;
}

function sum(arr = []) {
  return arr.reduce((a, b) => a + num(b), 0);
}

function isAddressLike(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) || /^0x[a-fA-F0-9]{40}$/.test(t);
}

function isLikelySolanaWallet(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t);
}

function hasHelius() {
  return !!HELIUS_API_KEY;
}

function hasEtherscanKey() {
  return !!ETHERSCAN_API_KEY;
}

function supportsChain(chainId) {
  return SUPPORTED_CHAINS.includes(String(chainId || "").toLowerCase());
}

function isEvmChain(chainId) {
  const c = String(chainId || "").toLowerCase();
  return c === "ethereum" || c === "base";
}

function humanChain(chainId) {
  const c = String(chainId || "").toLowerCase();
  if (c === "solana") return "Solana";
  if (c === "base") return "Base";
  if (c === "ethereum") return "Ethereum";
  return clip(c, 18) || "Unknown";
}

function buildGeneratedStamp() {
  return "Generated: just now";
}

function compactChainId(chainId) {
  const c = String(chainId || "").toLowerCase();
  if (c === "solana") return "s";
  if (c === "base") return "b";
  if (c === "ethereum") return "e";
  return c.slice(0, 1) || "x";
}

function expandCompactChainId(value) {
  const c = String(value || "").toLowerCase();
  if (c === "s") return "solana";
  if (c === "b") return "base";
  if (c === "e") return "ethereum";
  return c;
}

function safeSymbolText(symbol, fallback = "Token") {
  const s = String(symbol || "").trim();
  return s ? s : fallback;
}

function tradingConceptReply(lower) {
  if (/(entry|enter|buy in|good entry|bad entry|chasing)/i.test(lower)) {
    return [
      `🧠 <b>Trading Read</b>`,
      ``,
      `A cleaner entry usually has three things working together:`,
      `• liquidity that can absorb exits`,
      `• flow that is not obviously manufactured`,
      `• a setup you are not blindly chasing after a vertical move`,
      ``,
      `If price already exploded while liquidity is still thin, that is usually a worse entry than a calmer structure with real support underneath it.`
    ].join("\n");
  }
  if (/(liquidity|market cap|mcap|fdv)/i.test(lower)) {
    return [
      `🧠 <b>Liquidity vs Market Cap</b>`,
      ``,
      `Market cap tells you how large the token is priced.`,
      `Liquidity tells you how much real depth exists to enter or exit.`,
      ``,
      `A token can show a big market cap and still be dangerous if liquidity is thin.`,
      `That is why Gorktimus treats liquidity as one of the most important defensive inputs.`
    ].join("\n");
  }
  if (/(volume|transactions|tx|buys|sells|flow|spam)/i.test(lower)) {
    return [
      `🧠 <b>Volume / Transactions Read</b>`,
      ``,
      `High volume and high transactions are not automatically bullish.`,
      `The move matters more when activity is supported by decent liquidity and the recent flow does not look spammy or one-sided in a suspicious way.`,
      ``,
      `That is why the terminal looks at transaction behavior instead of treating raw activity as truth.`
    ].join("\n");
  }
  if (/(scalp|swing|hold|timeframe|time frame)/i.test(lower)) {
    return [
      `🧠 <b>Timeframe Read</b>`,
      ``,
      `Scalp logic cares more about current flow, spread, and immediate liquidity response.`,
      `Swing logic cares more about structure, holder concentration, and whether the move looks sustainable after the first burst.`,
      ``,
      `The same token can be tradable for a scalp and still be weak for a longer hold.`
    ].join("\n");
  }
  if (/(stop loss|risk reward|rr|position size|sizing|slippage)/i.test(lower)) {
    return [
      `🧠 <b>Risk Management</b>`,
      ``,
      `The cleaner the structure, the more room you have to think in terms of setups.`,
      `The weaker the liquidity and holder structure, the smaller the position should usually be.`,
      ``,
      `Early tokens are not where blind size belongs. They are where disciplined size matters most.`
    ].join("\n");
  }
  if (/(rug|trap|honeypot|tax)/i.test(lower)) {
    return [
      `🧠 <b>Trap / Rug Read</b>`,
      ``,
      `A dangerous token often shows a stack of weak signals together:`,
      `• thin liquidity`,
      `• concentration risk`,
      `• poor transparency`,
      `• ugly taxes or direct honeypot behavior`,
      `• spammy or manufactured flow`,
      ``,
      `Gorktimus is designed to weigh the stack, not just one signal in isolation.`
    ].join("\n");
  }
  return "";
}

function ageMinutesFromMs(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

function formatLaunchDate(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return "Unknown";
  const d = new Date(ms);
  return d.toLocaleString("en-US", {
    month: "short",
    year: "numeric"
  });
}

function ageFromMs(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return "N/A";

  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffMin < 60) return `${diffMin}m`;
  if (diffHrs < 24) return `${diffHrs}h`;
  if (diffDays < 30) return `${diffDays}d`;

  return formatLaunchDate(createdAtMs);
}

function makeDexUrl(chainId, pairAddress, fallbackUrl = "") {
  if (fallbackUrl) return fallbackUrl;
  if (!chainId || !pairAddress) return "";
  return `https://dexscreener.com/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
}

function makeBirdeyeUrl(chainId, tokenAddress) {
  const chain = String(chainId || "").toLowerCase();
  const token = String(tokenAddress || "").trim();
  if (!token) return "";
  if (chain === "solana") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=solana`;
  }
  if (chain === "base") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=base`;
  }
  if (chain === "ethereum") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=ethereum`;
  }
  return "";
}

function makeGeckoUrl(chainId, pairAddress) {
  const chain = String(chainId || "").toLowerCase();
  const pair = String(pairAddress || "").trim();
  if (!pair) return "";
  if (chain === "solana") {
    return `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(pair)}`;
  }
  if (chain === "base") {
    return `https://www.geckoterminal.com/base/pools/${encodeURIComponent(pair)}`;
  }
  if (chain === "ethereum") {
    return `https://www.geckoterminal.com/eth/pools/${encodeURIComponent(pair)}`;
  }
  return "";
}

function getMsgChat(msgOrQuery) {
  return msgOrQuery?.message?.chat || msgOrQuery?.chat || null;
}

function isPrivateChat(msgOrQuery) {
  const chat = getMsgChat(msgOrQuery);
  return chat?.type === "private";
}

function buildBotDeepLink() {
  if (!BOT_USERNAME) return "";
  return `https://t.me/${BOT_USERNAME}`;
}

function setTokenContext(chatId, pair, source = "token") {
  if (!chatId || !pair) return;
  currentTokenContext.set(String(chatId), {
    chainId: String(pair.chainId || ""),
    tokenAddress: String(pair.baseAddress || ""),
    pairAddress: String(pair.pairAddress || ""),
    symbol: String(pair.baseSymbol || ""),
    source,
    ts: nowTs()
  });
}

function getTokenContext(chatId) {
  return currentTokenContext.get(String(chatId)) || null;
}

function normalizeCallbackData(data) {
  const aliases = {
    main_menu: "mm",
    scan_token: "sc",
    trending: "lbv",
    launch_radar: "lrv",
    prime_picks: "afv",
    watchlist: "wlv",
    mode_lab: "mlv",
    alert_center: "dcv",
    whale_menu: "wiv",
    edge_brain: "eev",
    ai_assistant: "aiv",
    help_menu: "ihv",
    invite_friends: "inv",
    check_subscription: "chk",
    help_engine: "ihe",
    help_dex_diff: "ihd",
    help_transactions: "iht",
    help_score: "ihs",
    help_sources: "ihsrc",
    help_community: "ihc"
  };
  return aliases[data] || data;
}

function buildBackButton(callback = "mm", label = "⬅️ Back") {
  return { text: label, callback_data: callback };
}

function buildRefreshMainButtons(refreshCallback) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔁 Refresh", callback_data: refreshCallback }],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
}

// ================= USER / SUBSCRIPTION =================
async function upsertUserFromMessage(msg, isSubscribed = 0) {
  const ts = nowTs();
  const userId = String(msg.from?.id || "");
  const chatId = String(msg.chat?.id || "");
  const username = msg.from?.username || "";
  const firstName = msg.from?.first_name || "";
  const lastName = msg.from?.last_name || "";

  if (!userId) return;

  await run(
    `
    INSERT INTO users (user_id, chat_id, username, first_name, last_name, is_subscribed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      is_subscribed = excluded.is_subscribed,
      updated_at = excluded.updated_at
    `,
    [userId, chatId, username, firstName, lastName, isSubscribed ? 1 : 0, ts, ts]
  );
}

async function setUserSubscription(userId, isSubscribed) {
  await run(
    `UPDATE users SET is_subscribed = ?, updated_at = ? WHERE user_id = ?`,
    [isSubscribed ? 1 : 0, nowTs(), String(userId)]
  );
}

async function getBotUserCount() {
  const row = await get(`SELECT COUNT(*) AS c FROM users`, []);
  return row?.c || 0;
}

async function getVerifiedSubscriberBotUsersCount() {
  const row = await get(`SELECT COUNT(*) AS c FROM users WHERE is_subscribed = 1`, []);
  return row?.c || 0;
}

async function getChannelSubscriberCount() {
  try {
    const count = await bot.getChatMemberCount(REQUIRED_CHANNEL);
    return count;
  } catch (err) {
    console.log("getChannelSubscriberCount error:", err.message);
    return null;
  }
}

function safeMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (["aggressive", "balanced", "guardian"].includes(m)) return m;
  return "balanced";
}

function modeTitle(mode) {
  const m = safeMode(mode);
  if (m === "aggressive") return "Aggressive";
  if (m === "guardian") return "Guardian";
  return "Balanced";
}

async function ensureUserSettings(userId) {
  const ts = nowTs();
  await run(
    `INSERT OR IGNORE INTO user_settings (user_id, created_at, updated_at) VALUES (?, ?, ?)`,
    [String(userId), ts, ts]
  );
}

async function getUserSettings(userId) {
  await ensureUserSettings(userId);
  const row = await get(`SELECT * FROM user_settings WHERE user_id = ?`, [String(userId)]);
  return row || {
    user_id: String(userId),
    mode: "balanced",
    alerts_enabled: 1,
    launch_alerts: 1,
    smart_alerts: 1,
    risk_alerts: 1,
    whale_alerts: 1,
    explanation_level: "deep"
  };
}

async function setUserSetting(userId, field, value) {
  const allowed = new Set([
    "mode",
    "alerts_enabled",
    "launch_alerts",
    "smart_alerts",
    "risk_alerts",
    "whale_alerts",
    "explanation_level"
  ]);
  if (!allowed.has(field)) throw new Error(`Invalid setting field: ${field}`);
  await ensureUserSettings(userId);
  await run(
    `UPDATE user_settings SET ${field} = ?, updated_at = ? WHERE user_id = ?`,
    [value, nowTs(), String(userId)]
  );
}

function getMemoryKey(pair) {
  const chain = String(pair?.chainId || '').toLowerCase();
  const token = String(pair?.baseAddress || pair?.pairAddress || '').toLowerCase();
  return `${chain}:${token}`;
}

async function getPairMemory(pair) {
  const key = getMemoryKey(pair);
  const row = await get(`SELECT * FROM pair_memory WHERE memory_key = ?`, [key]);
  return row || {
    memory_key: key,
    learned_bias: 0,
    positive_events: 0,
    negative_events: 0,
    last_outcome: "none",
    last_price: 0,
    last_liquidity: 0,
    last_volume: 0,
    last_seen_at: 0
  };
}

async function savePairMemorySnapshot(pair, verdictScore = null) {
  const key = getMemoryKey(pair);
  const old = await getPairMemory(pair);
  const price = num(pair?.priceUsd);
  const liquidity = num(pair?.liquidityUsd);
  const volume = num(pair?.volumeH24);
  let learnedBias = num(old.learned_bias);
  let positive = num(old.positive_events);
  let negative = num(old.negative_events);
  let outcome = old.last_outcome || "none";

  if (num(old.last_seen_at) > 0) {
    const priceDelta = old.last_price > 0 ? ((price - old.last_price) / old.last_price) * 100 : 0;
    const liqDelta = old.last_liquidity > 0 ? ((liquidity - old.last_liquidity) / old.last_liquidity) * 100 : 0;
    const volDelta = old.last_volume > 0 ? ((volume - old.last_volume) / old.last_volume) * 100 : 0;

    let signal = 0;
    if (priceDelta >= 8) signal += 1;
    if (liqDelta >= 10) signal += 1;
    if (volDelta >= 15) signal += 1;
    if (priceDelta <= -12) signal -= 1;
    if (liqDelta <= -18) signal -= 1;

    if (signal >= 2) {
      learnedBias = Math.min(8, learnedBias + 1.25);
      positive += 1;
      outcome = "improving";
    } else if (signal <= -2) {
      learnedBias = Math.max(-10, learnedBias - 1.5);
      negative += 1;
      outcome = "weakening";
    }
  }

  await run(
    `INSERT INTO pair_memory (memory_key, learned_bias, positive_events, negative_events, last_outcome, last_price, last_liquidity, last_volume, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_key) DO UPDATE SET
       learned_bias = excluded.learned_bias,
       positive_events = excluded.positive_events,
       negative_events = excluded.negative_events,
       last_outcome = excluded.last_outcome,
       last_price = excluded.last_price,
       last_liquidity = excluded.last_liquidity,
       last_volume = excluded.last_volume,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
    [key, learnedBias, positive, negative, outcome, price, liquidity, volume, nowTs(), nowTs()]
  );

  return { learnedBias, positive, negative, outcome, verdictScore };
}

async function addScanFeedback(userId, pair, feedback, scoreSnapshot = 0) {
  await run(
    `INSERT INTO scan_feedback (user_id, chain_id, token_address, pair_address, symbol, feedback, score_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(userId),
      String(pair?.chainId || ''),
      String(pair?.baseAddress || ''),
      String(pair?.pairAddress || ''),
      String(pair?.baseSymbol || ''),
      String(feedback || ''),
      num(scoreSnapshot),
      nowTs()
    ]
  );

  const current = await getPairMemory(pair);
  let learnedBias = num(current.learned_bias);
  let positive = num(current.positive_events);
  let negative = num(current.negative_events);
  let outcome = current.last_outcome || 'none';

  if (feedback === 'good') {
    learnedBias = Math.min(10, learnedBias + 2);
    positive += 1;
    outcome = 'user_confirmed_good';
  } else if (feedback === 'bad') {
    learnedBias = Math.max(-12, learnedBias - 2.5);
    negative += 1;
    outcome = 'user_confirmed_bad';
  }

  await run(
    `INSERT INTO pair_memory (memory_key, learned_bias, positive_events, negative_events, last_outcome, last_price, last_liquidity, last_volume, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_key) DO UPDATE SET
       learned_bias = excluded.learned_bias,
       positive_events = excluded.positive_events,
       negative_events = excluded.negative_events,
       last_outcome = excluded.last_outcome,
       updated_at = excluded.updated_at`,
    [getMemoryKey(pair), learnedBias, positive, negative, outcome, num(current.last_price), num(current.last_liquidity), num(current.last_volume), num(current.last_seen_at), nowTs()]
  );
}

async function addWatchlistItem(chatId, pair) {
  const ts = nowTs();
  await run(
    `INSERT INTO watchlist (chat_id, chain_id, token_address, symbol, pair_address, active, alerts_enabled, added_price, last_price, last_liquidity, last_volume, last_score, last_alert_ts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(chat_id, chain_id, token_address) DO UPDATE SET
       symbol = excluded.symbol,
       pair_address = excluded.pair_address,
       last_price = excluded.last_price,
       last_liquidity = excluded.last_liquidity,
       last_volume = excluded.last_volume,
       updated_at = excluded.updated_at,
       active = 1`,
    [
      String(chatId),
      String(pair.chainId || ''),
      String(pair.baseAddress || ''),
      String(pair.baseSymbol || ''),
      String(pair.pairAddress || ''),
      num(pair.priceUsd),
      num(pair.priceUsd),
      num(pair.liquidityUsd),
      num(pair.volumeH24),
      ts,
      ts
    ]
  );
}

async function removeWatchlistItem(chatId, chainId, tokenAddress) {
  await run(`DELETE FROM watchlist WHERE chat_id = ? AND chain_id = ? AND token_address = ?`, [String(chatId), String(chainId), String(tokenAddress)]);
}

async function getWatchlistItems(chatId) {
  return await all(
    `SELECT * FROM watchlist WHERE chat_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT ?`,
    [String(chatId), MAX_WATCHLIST_ITEMS]
  );
}

async function getWatchlistCount(chatId) {
  const row = await get(`SELECT COUNT(*) AS c FROM watchlist WHERE chat_id = ? AND active = 1`, [String(chatId)]);
  return row?.c || 0;
}

function buildWatchlistItemCallback(chainId, tokenAddress) {
  return `watch_open:${compactChainId(chainId)}:${String(tokenAddress)}`;
}

function explainBias(memory) {
  const bias = num(memory?.learned_bias);
  if (bias >= 5) return "Adaptive memory strongly positive";
  if (bias >= 2) return "Adaptive memory slightly positive";
  if (bias <= -5) return "Adaptive memory strongly negative";
  if (bias <= -2) return "Adaptive memory slightly negative";
  return "Adaptive memory neutral";
}

async function isUserSubscribed(userId) {
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    const ok = ["member", "administrator", "creator"].includes(member.status);
    await setUserSubscription(userId, ok);
    return ok;
  } catch (err) {
    console.log(`isUserSubscribed error for ${userId}:`, err.message);
    await setUserSubscription(userId, 0).catch(() => {});
    return false;
  }
}

function buildSubscriptionGate() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Join Channel", url: COMMUNITY_TELEGRAM_URL }],
        [{ text: "✅ I Joined / Check Again", callback_data: "check_subscription" }]
      ]
    }
  };
}

async function showSubscriptionRequired(chatId) {
  await sendMenu(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🚫 <b>Access Locked</b>\n\nYou must join the official channel before using the bot.\n\nRequired channel: <b>${escapeHtml(
      REQUIRED_CHANNEL
    )}</b>`,
    buildSubscriptionGate()
  );
}

async function ensureSubscribedOrBlock(msgOrQuery) {
  const from = msgOrQuery.from;
  const chatId = msgOrQuery.message?.chat?.id || msgOrQuery.chat?.id;
  if (!from?.id || !chatId) return false;

  const ok = await isUserSubscribed(from.id);
  if (!ok) {
    await showSubscriptionRequired(chatId);
    return false;
  }
  return true;
}

// ================= MENUS =================
function buildMainMenu() {
  const growthRow = BOT_USERNAME
    ? [{ text: "🚀 Invite Network", callback_data: "inv" }]
    : [];

  const keyboard = [
    [
      { text: "🔎 Scan Token", callback_data: "sc" },
      { text: "📈 Trending", callback_data: "lbv" }
    ],
    [
      { text: "📡 Launch Radar", callback_data: "lrv" },
      { text: "💎 Alpha Feed", callback_data: "afv" }
    ],
    [
      { text: "👁 Watchlist", callback_data: "wlv" },
      { text: "🧬 Mode Lab", callback_data: "mlv" }
    ],
    [
      { text: "🛡 Defense Center", callback_data: "dcv" },
      { text: "🐋 Whale Intel", callback_data: "wiv" }
    ],
    [
      { text: "🧠 Edge Engine", callback_data: "eev" },
      { text: "🤖 AI Terminal", callback_data: "aiv" }
    ],
    [[{ text: "❓ Intel Hub", callback_data: "ihv" }, { text: "⚙️ Settings", callback_data: "stv" }]]
  ];

  if (growthRow.length) keyboard.push(growthRow);

  return {
    reply_markup: {
      inline_keyboard: keyboard
    }
  };
}

function buildHelpMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📖 How Gorktimus Works", callback_data: "ihe" }],
        [{ text: "📊 Why It Differs From Dex", callback_data: "ihd" }],
        [{ text: "🛡 Safety Score + Confidence", callback_data: "ihs" }],
        [{ text: "🔄 Transactions / Flow Explained", callback_data: "iht" }],
        [{ text: "⚙️ Data Sources", callback_data: "ihsrc" }],
        [{ text: "💬 Contact / Community", callback_data: "ihc" }],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
}

function buildAIAssistantMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📖 How It Works", callback_data: "ihe" },
          { text: "📊 Why Not Dex", callback_data: "ihd" }
        ],
        [
          { text: "🔄 Transactions", callback_data: "iht" },
          { text: "🛡 Safety Score", callback_data: "ihs" }
        ],
        [
          { text: "🔎 Scan Token", callback_data: "sc" },
          { text: "🏠 Exit Assistant", callback_data: "mm" }
        ]
      ]
    }
  };
}

function buildWhaleMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Add Whale", callback_data: "add_whale" },
          { text: "📋 Whale List", callback_data: "whale_list" }
        ],
        [
          { text: "➕ Add Dev Wallet", callback_data: "add_dev" },
          { text: "📋 Dev List", callback_data: "dev_list" }
        ],
        [
          { text: "🔍 Check Wallet", callback_data: "check_wallet" },
          { text: "⚙️ Alert Settings", callback_data: "wallet_alert_settings" }
        ],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
}

function buildModeMenu(currentMode) {
  const mode = safeMode(currentMode);
  const mark = (name, title) => ({
    text: mode === name ? `✅ ${title}` : title,
    callback_data: `set_mode:${name}`
  });
  return {
    reply_markup: {
      inline_keyboard: [
        [mark("aggressive", "A — Aggressive")],
        [mark("balanced", "B — Balanced")],
        [mark("guardian", "C — Guardian")],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
}

function buildAlertCenterMenu(settings) {
  const mark = (v) => (num(v) ? "✅" : "❌");
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `${mark(settings.alerts_enabled)} Master Alerts`, callback_data: "toggle_setting:alerts_enabled" }],
        [
          { text: `${mark(settings.launch_alerts)} Launch Alerts`, callback_data: "toggle_setting:launch_alerts" },
          { text: `${mark(settings.smart_alerts)} Smart Alerts`, callback_data: "toggle_setting:smart_alerts" }
        ],
        [
          { text: `${mark(settings.risk_alerts)} Risk Alerts`, callback_data: "toggle_setting:risk_alerts" },
          { text: `${mark(settings.whale_alerts)} Whale Alerts`, callback_data: "toggle_setting:whale_alerts" }
        ],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
