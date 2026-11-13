require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { randomInt } = require("crypto");

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
const pickLimiter = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: "draft-7", legacyHeaders: false });
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const userQuery = `SELECT id, username, bio, best_score, lifetime_score, total_gems, games_played, xp, achievements
                    FROM users WHERE id = $1`;

async function getUser(id) {
  const result = await pool.query(userQuery, [id]);
  return result.rows[0] || null;
}
function publicUser(user) {
  return {
    username: user.username,
    bio: user.bio || "",
    bestScore: Number(user.best_score),
    lifetimeScore: Number(user.lifetime_score),
    totalGems: Number(user.total_gems),
    gamesPlayed: Number(user.games_played),
    xp: Number(user.xp),
    level: Math.floor(Number(user.xp) / 250) + 1,
    levelProgress: Number(user.xp) % 250,
    achievements: user.achievements || []
  };
}
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in first." });
  next();
};

function makeMines(tileCount, mineCount) {
  const positions = new Set();
  while (positions.size < mineCount) positions.add(randomInt(1, tileCount + 1));
  return [...positions];
}
function freshRound(roundNumber, tileCount, mineCount) {
  return { round: roundNumber, tileCount, mineCount, mines: makeMines(tileCount, mineCount), revealed: [], points: 0, streak: 0, status: "playing" };
}
function gameView(game) {
  if (!game) return null;
  const round = game.round;
  const remaining = round.tileCount - round.revealed.length;
  return {
    runBank: game.runBank,
    round: round.round,
    tileCount: round.tileCount,
    mineCount: round.mineCount,
    points: round.points,
    streak: round.streak,
    revealed: round.revealed,
    status: round.status,
    mineTiles: round.status === "ended" ? round.mines : [],
    roundGems: round.revealed.length,
    safeTiles: round.tileCount - round.mineCount,
    totalGems: game.totalGems,
    safeChance: round.status === "playing" ? (remaining - round.mineCount) / remaining : 0,
    mineChance: round.status === "playing" ? round.mineCount / remaining : 0,
    message: game.message || ""
  };
}
function ensureGame(req) {
  if (!req.session.game) req.session.game = { runBank: 0, round: freshRound(1, 9, 3), totalGems: 0, message: "Choose your board and find the gems." };
  return req.session.game;
}
function finishRound(game, message) {
  game.round.status = "ended";
  game.message = message;
}
function nextRound(game) {
  game.round = freshRound(game.round.round + 1, game.settings.tileCount, game.settings.mineCount);
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
  req.session.game = null;
  res.json({ user: publicUser(await getUser(req.session.userId)), game: null });
}));

app.post("/api/login", authLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const result = await pool.query("SELECT id, password_hash FROM users WHERE username = $1", [username]);
  const account = result.rows[0];
  if (!account || !(await bcrypt.compare(password, account.password_hash))) return res.status(401).json({ error: "Incorrect username or password." });
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = account.id;
  req.session.game = null;
  res.json({ user: publicUser(await getUser(account.id)), game: null });
}));

app.post("/api/logout", (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", asyncRoute(async (req, res) => {
  if (!req.session.userId) return res.json({ user: null, game: null });
  const user = await getUser(req.session.userId);
  if (!user) return res.json({ user: null, game: null });
  res.json({ user: publicUser(user), game: gameView(req.session.game) });
}));

app.patch("/api/profile", requireAuth, asyncRoute(async (req, res) => {
  const bio = String(req.body.bio || "").trim().slice(0, 160);
  await pool.query("UPDATE users SET bio = $1 WHERE id = $2", [bio, req.session.userId]);
  res.json({ user: publicUser(await getUser(req.session.userId)) });
}));

app.get("/api/profile/:username", asyncRoute(async (req, res) => {
  const username = String(req.params.username || "").toLowerCase();
  const result = await pool.query(
    "SELECT username, bio, best_score, lifetime_score, total_gems, games_played, xp, achievements, created_at FROM users WHERE username = $1",
    [username]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Player not found." });
  const player = result.rows[0];
  res.json({ profile: { ...publicUser(player), joinedAt: player.created_at } });
}));

app.get("/api/leaderboard", asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT username, best_score, lifetime_score, total_gems, games_played FROM users ORDER BY best_score DESC, lifetime_score DESC, username ASC LIMIT 50");
  res.json({ players: result.rows.map((player, index) => ({
    rank: index + 1, username: player.username, bestScore: Number(player.best_score),
    lifetimeScore: Number(player.lifetime_score), totalGems: Number(player.total_gems), gamesPlayed: Number(player.games_played)
  })) });
}));

app.post("/api/game/start", requireAuth, (req, res) => {
  const tileCount = Number(req.body.tileCount ?? 9);
  const mineCount = Number(req.body.mineCount ?? 1);
  if (![9, 16, 25, 36].includes(tileCount)) return res.status(400).json({ error: "Choose a 9, 16, 25 or 36 tile board." });
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount >= tileCount) return res.status(400).json({ error: "Choose at least 1 mine and leave at least 1 gem." });
  req.session.game = {
    runBank: 0,
    settings: { tileCount, mineCount },
    round: freshRound(1, tileCount, mineCount),
    totalGems: 0,
    message: `New ${tileCount}-tile board. ${mineCount} hidden mines and at least one gem.`
  };
  res.json({ game: gameView(req.session.game) });
});

app.post("/api/game/pick", requireAuth, pickLimiter, (req, res) => {
  const game = ensureGame(req);
  const tile = Number(req.body.tile);
  const round = game.round;
  if (!Number.isInteger(tile) || tile < 1 || tile > round.tileCount) return res.status(400).json({ error: `Choose a tile from 1 to ${round.tileCount}.` });
  if (round.status !== "playing") return res.status(400).json({ error: "This round has ended. Start the next round." });
  if (round.revealed.includes(tile)) return res.status(400).json({ error: "You already opened that tile." });

  if (round.mines.includes(tile)) {
    const lost = round.points;
    round.points = 0;
    finishRound(game, `MINE HIT! ${lost} unbanked points lost. Your saved run bank is safe.`);
    return res.json({ game: gameView(game), event: "mine", lost });
  }

  round.revealed.push(tile);
  round.streak += 1;
  const gained = 10 * round.streak;
  round.points += gained;
  game.totalGems += 1;
  game.message = `GEM FOUND! +${gained} points · x${round.streak} streak`;

  if (round.revealed.length === round.tileCount - round.mineCount) {
    const bonus = 50 * round.round * round.mineCount;
    const total = round.points + bonus;
    game.runBank += total;
    round.points = 0;
    finishRound(game, `BOARD CLEARED! +${bonus} completion bonus. ${total} points added to your saved run bank.`);
    return res.json({ game: gameView(game), event: "perfect", bonus });
  }
  res.json({ game: gameView(game), event: "gem", gained });
});

app.post("/api/game/bank", requireAuth, (req, res) => {
  const game = ensureGame(req);
  if (game.round.status !== "playing") return res.status(400).json({ error: "This round has ended. Start the next one." });
  if (game.round.points <= 0) return res.status(400).json({ error: "Find a gem before banking." });
  const amount = game.round.points;
  game.runBank += amount;
  game.round.points = 0;
  finishRound(game, `${amount} points safely added to your run bank.`);
  res.json({ game: gameView(game), event: "banked", amount });
});

app.post("/api/game/continue", requireAuth, (req, res) => {
  const game = ensureGame(req);
  if (game.round.status === "playing") return res.status(400).json({ error: "Finish the current round first." });
  nextRound(game);
  game.message = `Round ${game.round.round}. ${game.round.mineCount} mines on a ${game.round.tileCount}-tile board.`;
  res.json({ game: gameView(game) });
});

app.post("/api/game/cashout", requireAuth, asyncRoute(async (req, res) => {
  const game = ensureGame(req);
  if (game.round.status === "playing" && game.round.points > 0) {
    game.runBank += game.round.points;
    game.round.points = 0;
  }
  const score = game.runBank;
  const xp = Math.max(25, Math.floor(score / 2) + game.totalGems * 2);
  const earned = [];
  if (game.totalGems >= 1) earned.push("first_gem");
  if (game.totalGems >= 25) earned.push("gem_collector");
  if (score >= 1000) earned.push("high_roller");
  if (game.round.round >= 5) earned.push("deep_run");
  await pool.query(`
    UPDATE users SET
      best_score = GREATEST(best_score, $1),
      lifetime_score = lifetime_score + $2,
      total_gems = total_gems + $3,
      games_played = games_played + 1,
      xp = xp + $4,
      achievements = ARRAY(SELECT DISTINCT unnest(achievements || $5::text[]))
    WHERE id = $6
  `, [score, score, game.totalGems, xp, earned, req.session.userId]);
  req.session.game = null;
  res.json({ score, xpEarned: xp, user: publicUser(await getUser(req.session.userId)) });
}));

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((error, req, res, next) => {
  console.error("Request failed:", error.message);
  if (res.headersSent) return next(error);
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
  app.listen(PORT, () => console.log(`LUCKY 9 running on port ${PORT}`));
}
startServer().catch(error => {
  console.error("Database connection or setup failed:", error.message);
  process.exit(1);
});
