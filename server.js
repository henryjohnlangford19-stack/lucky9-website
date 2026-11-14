require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { engines, HttpError, MIN_BET, MAX_BET } = require("./casino");

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}
if (isProduction && !process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is missing.");
  process.exit(1);
}
if (isProduction) app.set("trust proxy", 1);

// "sslmode=require" is treated as verify-full by pg; saying so explicitly silences the startup warning.
const connectionString = process.env.DATABASE_URL.replace(/sslmode=(require|prefer|verify-ca)/, "sslmode=verify-full");
const pool = new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: true }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(session({
  store: new PgSession({ pool, tableName: "lucky9_sessions", createTableIfMissing: true, pruneSessionInterval: 60 * 15 }),
  secret: process.env.SESSION_SECRET || "local-development-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 1000 * 60 * 60 * 24 * 30 }
}));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) return res.status(403).json({ error: "Cross-origin request blocked." });
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
const startLimiter = rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: "draft-7", legacyHeaders: false });
const actLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: "draft-7", legacyHeaders: false });
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const START_BALANCE = 10000;
const DAILY_BONUS = 2000;
const RESCUE_BONUS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESCUE_COOLDOWN_MS = 30 * 60 * 1000;

const userQuery = `SELECT id, username, bio, best_score, lifetime_score, total_gems, games_played, xp, achievements,
                          balance, last_bonus_at, last_rescue_at FROM users WHERE id = $1`;
async function getUser(id) {
  const result = await pool.query(userQuery, [id]);
  return result.rows[0] || null;
}
function bonusState(user, hasActive) {
  const now = Date.now();
  const last = user.last_bonus_at ? new Date(user.last_bonus_at).getTime() : 0;
  const lastRescue = user.last_rescue_at ? new Date(user.last_rescue_at).getTime() : 0;
  return {
    dailyReady: now - last >= DAY_MS,
    dailyAmount: DAILY_BONUS,
    nextDailyInMs: Math.max(0, DAY_MS - (now - last)),
    rescueReady: Number(user.balance) < MIN_BET && !hasActive && now - lastRescue >= RESCUE_COOLDOWN_MS,
    rescueAmount: RESCUE_BONUS
  };
}
function publicUser(user, hasActive = false) {
  return {
    username: user.username,
    bio: user.bio || "",
    balance: Number(user.balance),
    bestScore: Number(user.best_score),        // biggest single-round profit
    lifetimeScore: Number(user.lifetime_score), // total winnings
    gamesPlayed: Number(user.games_played),
    xp: Number(user.xp),
    level: Math.floor(Number(user.xp) / 250) + 1,
    levelProgress: Number(user.xp) % 250,
    achievements: user.achievements || [],
    bonus: bonusState(user, hasActive),
    minBet: MIN_BET,
    maxBet: MAX_BET
  };
}
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in first." });
  next();
};

/* ---------- wallet + atomic rounds ---------- */
async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
// Moves money and writes the matching ledger row. Must run inside a transaction with the user row locked.
async function moveMoney(client, userId, delta, kind, game) {
  const result = await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance", [delta, userId]);
  const balance = Number(result.rows[0].balance);
  await client.query("INSERT INTO transactions (user_id, kind, game, amount, balance_after) VALUES ($1, $2, $3, $4, $5)", [userId, kind, game, delta, balance]);
  return balance;
}
async function lockUser(client, userId) {
  const result = await client.query("SELECT balance FROM users WHERE id = $1 FOR UPDATE", [userId]);
  if (!result.rows[0]) throw new HttpError(401, "Please log in again.");
  return Number(result.rows[0].balance);
}
// Finishes a round (pays out, updates stats) or saves it so the player can continue it.
async function concludeRound(client, userId, game, wager, round, balance) {
  const engine = engines[game];
  if (!round.done) {
    await client.query(
      `INSERT INTO active_games (user_id, game, wager, state) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET game = EXCLUDED.game, wager = EXCLUDED.wager, state = EXCLUDED.state`,
      [userId, game, wager, JSON.stringify(round.state)]
    );
    return { done: false, game, balance, message: round.message || "", view: engine.view(round.state, false) };
  }
  await client.query("DELETE FROM active_games WHERE user_id = $1", [userId]);
  const payout = Math.max(0, Math.floor(round.payout || 0));
  if (payout > 0) balance = await moveMoney(client, userId, payout, "payout", game);
  const profit = payout - wager;
  const xp = Math.max(1, Math.floor(wager / 50));
  await client.query(
    `UPDATE users SET games_played = games_played + 1, xp = xp + $1,
       best_score = GREATEST(best_score, $2), lifetime_score = lifetime_score + GREATEST($2, 0) WHERE id = $3`,
    [xp, profit, userId]
  );
  return { done: true, game, balance, payout, profit, wager, message: round.message || "", view: engine.view(round.state, true) };
}
function validateBet(value) {
  const bet = Number(value);
  if (!Number.isSafeInteger(bet) || bet < MIN_BET || bet > MAX_BET) throw new HttpError(400, `Bets must be whole numbers from ${MIN_BET.toLocaleString()} to ${MAX_BET.toLocaleString()}.`);
  return bet;
}

app.get("/api/health", (req, res) => res.json({ ok: true, service: "lucky9" }));

app.post("/api/register", authLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error: "Username must be 3–16 lowercase letters, numbers or underscores." });
  if (password.length < 8 || password.length > 72 || Buffer.byteLength(password, "utf8") > 72) return res.status(400).json({ error: "Password must be between 8 and 72 characters." });
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING RETURNING id", [username, passwordHash]);
  if (!result.rows[0]) return res.status(409).json({ error: "That username is already taken." });
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = result.rows[0].id;
  await pool.query("INSERT INTO transactions (user_id, kind, game, amount, balance_after) VALUES ($1, 'bonus', 'welcome', $2, $2)", [req.session.userId, START_BALANCE]);
  await pool.query("UPDATE users SET last_bonus_at = NOW() WHERE id = $1", [req.session.userId]); // first daily bonus comes after 24h
  res.json({ user: publicUser(await getUser(req.session.userId)) });
}));

app.post("/api/login", authLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const result = await pool.query("SELECT id, password_hash FROM users WHERE username = $1", [username]);
  const account = result.rows[0];
  if (!account || !(await bcrypt.compare(password, account.password_hash))) return res.status(401).json({ error: "Incorrect username or password." });
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = account.id;
  res.json({ user: publicUser(await getUser(account.id)) });
}));

app.post("/api/logout", (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", asyncRoute(async (req, res) => {
  if (!req.session.userId) return res.json({ user: null, active: null });
  const user = await getUser(req.session.userId);
  if (!user) return res.json({ user: null, active: null });
  const row = (await pool.query("SELECT game, state FROM active_games WHERE user_id = $1", [user.id])).rows[0];
  const active = row ? { game: row.game, view: engines[row.game].view(row.state, false) } : null;
  res.json({ user: publicUser(user, !!active), active });
}));

app.patch("/api/profile", requireAuth, asyncRoute(async (req, res) => {
  const bio = String(req.body.bio || "").trim().slice(0, 160);
  await pool.query("UPDATE users SET bio = $1 WHERE id = $2", [bio, req.session.userId]);
  res.json({ user: publicUser(await getUser(req.session.userId)) });
}));

app.get("/api/profile/:username", asyncRoute(async (req, res) => {
  const username = String(req.params.username || "").toLowerCase();
  const result = await pool.query(
    "SELECT username, bio, best_score, lifetime_score, total_gems, games_played, xp, achievements, balance, created_at FROM users WHERE username = $1",
    [username]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Player not found." });
  const player = result.rows[0];
  const { bonus, minBet, maxBet, ...profile } = publicUser(player);
  res.json({ profile: { ...profile, joinedAt: player.created_at } });
}));

app.get("/api/leaderboard", asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT username, balance, best_score, lifetime_score, games_played FROM users ORDER BY balance DESC, best_score DESC, username ASC LIMIT 50");
  res.json({ players: result.rows.map((player, index) => ({
    rank: index + 1, username: player.username, balance: Number(player.balance), bestWin: Number(player.best_score),
    bestScore: Number(player.best_score), lifetimeScore: Number(player.lifetime_score), gamesPlayed: Number(player.games_played)
  })) });
}));

/* ---------- wallet ---------- */
app.get("/api/wallet/transactions", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT kind, game, amount, balance_after, created_at FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 30", [req.session.userId]);
  res.json({ transactions: result.rows.map(r => ({ kind: r.kind, game: r.game, amount: Number(r.amount), balance: Number(r.balance_after), at: r.created_at })) });
}));

app.post("/api/wallet/claim", requireAuth, startLimiter, asyncRoute(async (req, res) => {
  const out = await inTransaction(async client => {
    await lockUser(client, req.session.userId);
    const row = (await client.query("SELECT balance, last_bonus_at, last_rescue_at FROM users WHERE id = $1", [req.session.userId])).rows[0];
    const active = (await client.query("SELECT 1 FROM active_games WHERE user_id = $1", [req.session.userId])).rows.length > 0;
    const state = bonusState(row, active);
    if (state.rescueReady) {
      const balance = await moveMoney(client, req.session.userId, RESCUE_BONUS, "bonus", "rescue");
      await client.query("UPDATE users SET last_rescue_at = NOW() WHERE id = $1", [req.session.userId]);
      return { amount: RESCUE_BONUS, balance, message: `You're topped up with ${RESCUE_BONUS.toLocaleString()} free chips.` };
    }
    if (state.dailyReady) {
      const balance = await moveMoney(client, req.session.userId, DAILY_BONUS, "bonus", "daily");
      await client.query("UPDATE users SET last_bonus_at = NOW() WHERE id = $1", [req.session.userId]);
      return { amount: DAILY_BONUS, balance, message: `Daily bonus claimed: +${DAILY_BONUS.toLocaleString()} chips!` };
    }
    const hours = Math.ceil(state.nextDailyInMs / 3600000);
    throw new HttpError(400, `Your next daily bonus is ready in about ${hours} hour${hours === 1 ? "" : "s"}.`);
  });
  const user = await getUser(req.session.userId);
  res.json({ ...out, user: publicUser(user) });
}));

/* ---------- casino rounds (server decides everything) ---------- */
app.post("/api/casino/start", requireAuth, startLimiter, asyncRoute(async (req, res) => {
  const game = String(req.body.game || "");
  const engine = engines[game];
  if (!engine) throw new HttpError(400, "Unknown game.");
  const bet = validateBet(req.body.bet);
  const params = req.body.params && typeof req.body.params === "object" ? req.body.params : {};
  const userId = req.session.userId;
  const out = await inTransaction(async client => {
    let balance = await lockUser(client, userId);
    const existing = (await client.query("SELECT game, state FROM active_games WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
    if (existing) {
      if (existing.game !== game) throw new HttpError(409, `Finish your ${engines[existing.game].name} round first — open that game to continue it or forfeit it.`);
      return { done: false, resumed: true, game, balance, message: "Resuming your round.", view: engine.view(existing.state, false) };
    }
    if (bet > balance) throw new HttpError(400, "Not enough chips for that bet.");
    balance = await moveMoney(client, userId, -bet, "bet", game);
    const round = engine.start(bet, params); // throws (and rolls the bet back) on invalid choices
    return concludeRound(client, userId, game, bet, round, balance);
  });
  res.json({ ...out, user: publicUser(await getUser(userId), !out.done) });
}));

app.post("/api/casino/act", requireAuth, actLimiter, asyncRoute(async (req, res) => {
  const action = String(req.body.action || "");
  const params = req.body.params && typeof req.body.params === "object" ? req.body.params : {};
  const userId = req.session.userId;
  const out = await inTransaction(async client => {
    let balance = await lockUser(client, userId);
    const active = (await client.query("SELECT game, wager, state FROM active_games WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
    if (!active) throw new HttpError(409, "You have no round in progress.");
    const engine = engines[active.game];
    if (!engine.act) throw new HttpError(400, "This game has no further actions.");
    const round = engine.act(active.state, action, params);
    let wager = Number(active.wager);
    if (round.extraBet) {
      if (round.extraBet > balance) throw new HttpError(400, "Not enough chips for that move.");
      balance = await moveMoney(client, userId, -round.extraBet, "bet", active.game);
      wager += round.extraBet;
    }
    return concludeRound(client, userId, active.game, wager, round, balance);
  });
  res.json({ ...out, user: publicUser(await getUser(userId), !out.done) });
}));

// Abandon a round: the stake is forfeited (Bingo pays whatever the ticket has already earned).
app.post("/api/casino/forfeit", requireAuth, startLimiter, asyncRoute(async (req, res) => {
  const userId = req.session.userId;
  const out = await inTransaction(async client => {
    const balance = await lockUser(client, userId);
    const active = (await client.query("SELECT game, wager, state FROM active_games WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
    if (!active) throw new HttpError(409, "You have no round in progress.");
    const engine = engines[active.game];
    const payout = engine.forfeit ? engine.forfeit(active.state) : 0;
    return concludeRound(client, userId, active.game, Number(active.wager), { done: true, state: active.state, payout, message: "Round ended." }, balance);
  });
  res.json({ ...out, user: publicUser(await getUser(userId)) });
}));

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  console.error("Request failed:", error.message);
  res.status(500).json({ error: "Server error. Please try again in a moment." });
});

async function startServer() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(16) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      bio VARCHAR(160) NOT NULL DEFAULT '',
      best_score BIGINT NOT NULL DEFAULT 0,
      lifetime_score BIGINT NOT NULL DEFAULT 0,
      total_gems BIGINT NOT NULL DEFAULT 0,
      games_played BIGINT NOT NULL DEFAULT 0,
      xp BIGINT NOT NULL DEFAULT 0,
      achievements TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(160) NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS achievements TEXT[] NOT NULL DEFAULT '{}'");
  // wallet
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance BIGINT NOT NULL DEFAULT ${START_BALANCE}`);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_bonus_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_rescue_at TIMESTAMPTZ");
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_balance_nonneg') THEN ALTER TABLE users ADD CONSTRAINT users_balance_nonneg CHECK (balance >= 0); END IF; END $$");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      game TEXT NOT NULL,
      amount BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS transactions_user_idx ON transactions (user_id, id DESC)");
  // Existing accounts get their opening balance recorded so every balance can be reconciled with the ledger.
  await pool.query(`INSERT INTO transactions (user_id, kind, game, amount, balance_after)
                    SELECT u.id, 'bonus', 'welcome', u.balance, u.balance FROM users u
                    WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = u.id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_games (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      game TEXT NOT NULL,
      wager BIGINT NOT NULL,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  app.listen(PORT, () => console.log(`LUCKY 9 running on port ${PORT}`));
}
startServer().catch(error => {
  console.error("Database connection or setup failed:", error.message);
  process.exit(1);
});
