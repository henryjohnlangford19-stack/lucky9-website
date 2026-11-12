const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

if (isProduction) app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(dataDir, "lucky9.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions(expired);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    best_score INTEGER NOT NULL DEFAULT 0,
    lifetime_score INTEGER NOT NULL DEFAULT 0,
    total_gems INTEGER NOT NULL DEFAULT 0,
    games_played INTEGER NOT NULL DEFAULT 0,
    xp INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.getStmt = database.prepare("SELECT sess, expired FROM sessions WHERE sid = ?");
    this.setStmt = database.prepare("INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired");
    this.destroyStmt = database.prepare("DELETE FROM sessions WHERE sid = ?");
    this.touchStmt = database.prepare("UPDATE sessions SET expired = ? WHERE sid = ?");
    this.cleanupStmt = database.prepare("DELETE FROM sessions WHERE expired <= ?");
  }
  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return callback(null, null);
      if (row.expired <= Date.now()) { this.destroyStmt.run(sid); return callback(null, null); }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.setStmt.run(sid, JSON.stringify(sess), expires);
      this.cleanupStmt.run(Date.now());
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { this.destroyStmt.run(sid); callback(null); } catch (error) { callback(error); }
  }
  touch(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.touchStmt.run(expires, sid); callback(null);
    } catch (error) { callback(error); }
  }
}

app.use(session({
  store: new SQLiteSessionStore(db),
  secret: process.env.SESSION_SECRET || "dev-only-change-this-secret-before-deploying",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

// Reject cross-origin browser writes. SameSite cookies provide an additional CSRF barrier.
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "Cross-origin request blocked." });
    }
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
const pickLimiter = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: "draft-7", legacyHeaders: false });

const getUser = id => db.prepare("SELECT id, username, best_score, lifetime_score, total_gems, games_played, xp FROM users WHERE id = ?").get(id);
const publicUser = user => ({
  username: user.username,
  bestScore: user.best_score,
  lifetimeScore: user.lifetime_score,
  totalGems: user.total_gems,
  gamesPlayed: user.games_played,
  xp: user.xp,
  level: Math.floor(user.xp / 250) + 1,
  levelProgress: user.xp % 250
});
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in first." });
  next();
};

function freshRound(round) {
  return { round, bomb: Math.floor(Math.random() * 9) + 1, revealed: [], points: 0, streak: 0, status: "playing" };
}
function gameView(game) {
  if (!game) return null;
  return {
    runBank: game.runBank,
    round: game.round.round,
    points: game.round.points,
    streak: game.round.streak,
    revealed: game.round.revealed,
    status: game.round.status,
    bombTile: game.round.status === "ended" ? game.round.bomb : null,
    roundGems: game.round.revealed.length,
    totalGems: game.totalGems,
    message: game.message || ""
  };
}
function ensureGame(req) {
  if (!req.session.game) {
    req.session.game = { runBank: 0, round: freshRound(1), totalGems: 0, message: "Find gems, build your streak, and decide when to bank." };
  }
  return req.session.game;
}
function finishRound(game, message) {
  game.round.status = "ended";
  game.message = message;
}
function nextRound(game) {
  game.round = freshRound(game.round.round + 1);
}

app.get("/api/health", (req, res) => res.json({ ok: true, service: "lucky9" }));

app.post("/api/register", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9_]{3,16}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3–16 characters, lowercase letters, numbers or underscores only." });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: "Password must be between 8 and 72 characters." });
  }
  const exists = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (exists) return res.status(409).json({ error: "That username is already taken." });
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
    req.session.userId = result.lastInsertRowid;
    req.session.game = null;
    res.json({ user: publicUser(getUser(req.session.userId)), game: null });
  } catch {
    res.status(409).json({ error: "That username is already taken." });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  req.session.userId = user.id;
  req.session.game = null;
  res.json({ user: publicUser(getUser(user.id)), game: null });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null, game: null });
  const user = getUser(req.session.userId);
  if (!user) return res.json({ user: null, game: null });
  res.json({ user: publicUser(user), game: gameView(req.session.game) });
});

app.get("/api/leaderboard", (req, res) => {
  const rows = db.prepare(`
    SELECT username, best_score, lifetime_score, total_gems, games_played
    FROM users ORDER BY best_score DESC, lifetime_score DESC, username ASC LIMIT 50
  `).all();
  res.json({ players: rows.map((p, i) => ({
    rank: i + 1, username: p.username, bestScore: p.best_score,
    lifetimeScore: p.lifetime_score, totalGems: p.total_gems, gamesPlayed: p.games_played
  })) });
});

app.post("/api/game/start", requireAuth, (req, res) => {
  req.session.game = {
    runBank: 0, round: freshRound(1), totalGems: 0,
    message: "New run started. Eight gems are hiding among the nine tiles."
  };
  res.json({ game: gameView(req.session.game) });
});

app.post("/api/game/pick", requireAuth, pickLimiter, (req, res) => {
  const game = ensureGame(req);
  const tile = Number(req.body.tile);
  if (!Number.isInteger(tile) || tile < 1 || tile > 9) return res.status(400).json({ error: "Choose a tile from 1 to 9." });
  if (game.round.status !== "playing") return res.status(400).json({ error: "Bank or continue to the next round first." });
  if (game.round.revealed.includes(tile)) return res.status(400).json({ error: "You already opened that tile." });

  if (tile === game.round.bomb) {
    const lost = game.round.points;
    finishRound(game, `BOOM! You lost ${lost} unbanked points. Your run bank is safe.`);
    return res.json({ game: gameView(game), event: "bomb", lost });
  }

  game.round.revealed.push(tile);
  game.round.streak += 1;
  game.round.points += 10 * game.round.streak;
  game.totalGems += 1;
  game.message = `Gem found! +${10 * game.round.streak} points · x${game.round.streak} streak`;

  if (game.round.revealed.length === 8) {
    const bonus = 50 * game.round.round;
    game.round.points += bonus;
    game.runBank += game.round.points;
    finishRound(game, `PERFECT ROUND! +${bonus} completion bonus. ${game.round.points} points safely banked.`);
    return res.json({ game: gameView(game), event: "perfect", bonus });
  }
  res.json({ game: gameView(game), event: "gem", gained: 10 * game.round.streak });
});

app.post("/api/game/bank", requireAuth, (req, res) => {
  const game = ensureGame(req);
  if (game.round.status !== "playing") return res.status(400).json({ error: "This round has ended. Start the next one." });
  if (game.round.points <= 0) return res.status(400).json({ error: "Find a gem before banking." });
  const amount = game.round.points;
  game.runBank += amount;
  finishRound(game, `${amount} points banked safely. Want to risk another round?`);
  res.json({ game: gameView(game), event: "banked", amount });
});

app.post("/api/game/continue", requireAuth, (req, res) => {
  const game = ensureGame(req);
  if (game.round.status === "playing") return res.status(400).json({ error: "Finish the current round first." });
  nextRound(game);
  game.message = `Round ${game.round.round}. The bank is safe — can you beat your streak?`;
  res.json({ game: gameView(game) });
});

app.post("/api/game/cashout", requireAuth, (req, res) => {
  const game = ensureGame(req);
  if (game.round.status === "playing" && game.round.points > 0) {
    game.runBank += game.round.points;
    game.round.points = 0;
  }
  const score = game.runBank;
  const xp = Math.max(25, Math.floor(score / 2) + game.totalGems * 2);
  db.prepare(`
    UPDATE users SET
      best_score = MAX(best_score, ?),
      lifetime_score = lifetime_score + ?,
      total_gems = total_gems + ?,
      games_played = games_played + 1,
      xp = xp + ?
    WHERE id = ?
  `).run(score, score, game.totalGems, xp, req.session.userId);
  req.session.game = null;
  res.json({ score, xpEarned: xp, user: publicUser(getUser(req.session.userId)) });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`LUCKY 9 running on http://localhost:${PORT}`));
