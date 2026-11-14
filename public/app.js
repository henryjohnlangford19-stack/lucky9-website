"use strict";
/* LUCKY 9 — browser app. The server deals, rolls, pays and keeps the balance; this file only draws what it is told. */
const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString();
const signed = n => (n > 0 ? "+" : n < 0 ? "−" : "±") + fmt(Math.abs(n));
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || (options.body ? "POST" : "GET"), credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

let user = null, authMode = "login", active = null, pending = null, busy = false, session = 0, bet = 100;
let ui = { view: null, res: null, live: false };
const sel = { roulette: { type: "red", number: 7 }, baccarat: "player", keno: [], held: [false, false, false, false, false] };
let crashClock = null, crashPoll = null, crashStart = 0, polling = false, toastTimer = null;
try { bet = Number(localStorage.getItem("l9bet")) || 100; } catch (e) { /* storage can be blocked */ }

/* ---------- game info ---------- */
const games = {
  slots: ["Neon Reels", "Five reels. Match symbols from the left on the centre line — 🃏 Wilds fill in.", "Pick your bet and spin."],
  blackjack: ["Blackjack 21", "Beat the dealer without going over 21. Blackjack pays 3:2.", "Place a bet to be dealt in."],
  roulette: ["European Roulette", "37 pockets, one zero. Choose your bet, then spin.", "Choose a bet, set your stake and spin."],
  poker: ["Texas Hold'em", "Casino Hold'em: you versus the dealer. Ante, see the flop, then raise or fold.", "Place your ante to see the flop."],
  baccarat: ["Baccarat", "Back the Player, the Banker or a Tie. Closest to nine wins.", "Choose a side and set your stake."],
  videopoker: ["Jacks or Better", "Hold the cards you like and draw. A pair of Jacks or better pays.", "Place a bet to be dealt five cards."],
  craps: ["Craps", "Pass Line bet: win on 7 or 11, lose on 2, 3 or 12, otherwise make the point.", "Place a Pass Line bet and roll."],
  bingo: ["90-Ball Bingo", "Buy a ticket and draw numbers. One line, two lines and a full house all pay.", "Buy a ticket to start drawing."],
  keno: ["Keno 80", "Pick 1 to 10 numbers. Twenty are drawn — more matches pay more.", "Pick your numbers, then play."],
  crash: ["Multiplier Lab", "The multiplier climbs until it crashes. Cash out before it does!", "Place a bet and watch the multiplier rise."]
};
const ruleText = {
  slots: "5 reels × 3 rows. Only the centre line pays: 3, 4 or 5 matching symbols counted from the left (🃏 Wilds count as any symbol). Rarer symbols pay more — five 7️⃣ pays 720×. Return to player is about 91%.",
  blackjack: "Cards count face value, J/Q/K = 10, A = 1 or 11. Dealer stands on all 17s. A win pays 1:1, Blackjack pays 3:2, a tie is a push. You can double down on your first two cards. Return is about 99% with good play.",
  roulette: "Pockets 0–36 (one green zero). Red/Black, Odd/Even and 1–18 / 19–36 pay 1:1. Dozens pay 2:1. A single number pays 35:1. Zero beats every outside bet. Return is 97.3%.",
  poker: "Pay an ante and get two cards plus a three-card flop. Raise (2× ante) to see the turn and river, or fold. Dealer needs a pair of 4s or better to qualify. Win: ante and raise pay 1:1 and a straight or better earns an ante bonus. Dealer doesn't qualify: ante pays, raise is returned.",
  baccarat: "Aces = 1, 2–9 face value, 10/J/Q/K = 0, totals use the last digit. Player pays 1:1, Banker pays 0.95:1 (5% commission), Tie pays 8:1 (Player/Banker bets push on a tie). Standard third-card rules apply.",
  videopoker: "Five cards, hold any, draw the rest. Pays: Jacks+ 1×, Two Pair 2×, Trips 3×, Straight 4×, Flush 6×, Full House 9×, Quads 25×, Straight Flush 50×, Royal Flush 250×.",
  craps: "Come-out: 7 or 11 wins, 2, 3 or 12 loses, any other total becomes the point. Roll the point again before a 7 to win. The Pass Line pays 1:1 (return 98.6%).",
  bingo: "A 90-ball ticket has 3 rows × 9 columns, 15 numbers. Up to 60 numbers are called. One line pays 2×, two lines 6×, a full house 80×. Draw one at a time or auto-draw.",
  keno: "Pick 1–10 numbers from 1–80. The server draws 20. The prize depends on how many of your picks match — and the more you pick, the bigger the top prize (up to 5,000×).",
  crash: "The multiplier rises from 1.00×. Press CASH OUT to take your stake × the current multiplier. If it crashes first, the stake is lost. The crash point is generated on the server (return about 97%)."
};
const rouletteChoices = [["red", "RED"], ["black", "BLACK"], ["odd", "ODD"], ["even", "EVEN"], ["low", "1–18"], ["high", "19–36"], ["dozen1", "1st 12"], ["dozen2", "2nd 12"], ["dozen3", "3rd 12"]];

/* ---------- small helpers ---------- */
function status(s) { $("gameStatus").textContent = s; }
function toast(message) {
  const t = $("toast"); t.textContent = message; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}
function btn(label, action, cls, extra) { return '<button type="button" class="' + (cls || "challenge-btn") + '" data-act="' + action + '" ' + (extra || "") + ">" + label + "</button>"; }
function card(c) { return '<span class="playing-card ' + ("♥♦".includes(c.s) ? "red-card" : "") + '"><b>' + esc(c.r) + "</b><strong>" + esc(c.s) + "</strong></span>"; }
const hiddenCard = '<span class="playing-card hidden-card">?</span>';
function banner(res) {
  if (!res || !res.done) return res && res.message ? '<p class="small-note">' + esc(res.message) + "</p>" : "";
  return '<div class="result-banner ' + (res.profit > 0 ? "win" : res.profit < 0 ? "lose" : "") + '">' + esc(res.message) + " <b>" + signed(res.profit) + "</b></div>";
}
function setSession() { const el = $("liveScore"); el.textContent = signed(session); el.className = session > 0 ? "up" : session < 0 ? "down" : ""; }
function clampBet() {
  bet = Math.floor(Number(bet) || 0);
  const max = user ? Math.min(user.maxBet, Math.max(user.balance, user.minBet)) : 10000;
  bet = Math.max(user ? user.minBet : 10, Math.min(bet, max));
  $("betInput").value = bet;
  try { localStorage.setItem("l9bet", String(bet)); } catch (e) { /* ignore */ }
}
function stopTimers() { clearInterval(crashClock); clearInterval(crashPoll); crashClock = crashPoll = null; }

/* ---------- account + wallet ---------- */
function renderUser() {
  const set = (id, v) => { $(id).textContent = v; };
  if (!user) {
    $("accountButton").textContent = "LOG IN ↗";
    set("balance", "—"); set("bestScore", "0"); set("gamesPlayed", "0"); set("level", "1");
    $("bonusButton").classList.add("hidden"); return;
  }
  $("accountButton").textContent = user.username.toUpperCase() + " ↗";
  set("balance", fmt(user.balance)); set("bestScore", fmt(user.bestScore)); set("gamesPlayed", fmt(user.gamesPlayed)); set("level", user.level);
  const b = user.bonus, bonusBtn = $("bonusButton");
  const ready = b.rescueReady || b.dailyReady;
  bonusBtn.classList.toggle("hidden", !ready);
  bonusBtn.textContent = "CLAIM +" + fmt(b.rescueReady ? b.rescueAmount : b.dailyAmount) + " FREE CHIPS ↗";
  clampBet();
}
async function refreshLeaderboard() {
  try {
    const d = await api("/api/leaderboard");
    $("leaderboard").innerHTML = d.players.length
      ? d.players.map(p => "<tr><td>#" + p.rank + "</td><td>" + esc(p.username) + "</td><td>" + fmt(p.bestWin) + "</td><td>" + fmt(p.balance) + "</td></tr>").join("")
      : '<tr><td colspan="4">No players yet. Be the first!</td></tr>';
  } catch (e) { $("leaderboard").innerHTML = '<tr><td colspan="4">Leaderboard unavailable right now.</td></tr>'; }
}
async function sync() {
  try {
    const d = await api("/api/me");
    user = d.user; pending = d.active; renderUser();
    $("connection").textContent = "● ONLINE";
  } catch (e) { $("connection").textContent = "OFFLINE"; }
}
function showModal(note) {
  $("modal").classList.remove("hidden"); $("authError").textContent = note || "";
  requestAnimationFrame(() => $("username").focus());
}
function setAuthMode(mode) {
  authMode = mode;
  $("loginTab").classList.toggle("active", mode === "login"); $("registerTab").classList.toggle("active", mode === "register");
  $("modalTitle").textContent = mode === "login" ? "Player login" : "Create player account";
  $("modalDescription").textContent = mode === "login" ? "Sign in to play with your chips and climb the rankings." : "New players start with 10,000 free play-money chips.";
  $("authSubmit").textContent = mode === "login" ? "LOG IN ↗" : "CREATE ACCOUNT ↗";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
}

/* ---------- selectors shown before a round ---------- */
const SELECT = {
  roulette() {
    const s = sel.roulette;
    return '<div class="table-label">YOUR BET</div><div class="action-row">' +
      rouletteChoices.map(([k, l]) => btn(l, "rt:" + k, "challenge-btn" + (s.type === k ? " good" : ""))).join("") +
      btn("NUMBER", "rt:straight", "challenge-btn" + (s.type === "straight" ? " good" : "")) +
      '<input id="rouletteNumber" class="num-input" type="number" inputmode="numeric" min="0" max="36" value="' + s.number + '" aria-label="Roulette number"></div>' +
      '<p class="small-note">Number pays 35:1 · Dozens 2:1 · Colours, odd/even, halves 1:1</p>';
  },
  baccarat() {
    return '<div class="table-label">BACK A SIDE</div><div class="action-row">' +
      [["player", "PLAYER · 1:1"], ["banker", "BANKER · 0.95:1"], ["tie", "TIE · 8:1"]].map(([k, l]) => btn(l, "bs:" + k, "challenge-btn" + (sel.baccarat === k ? " good" : ""))).join("") + "</div>";
  },
  keno() { return ui.view ? "" : kenoGrid(null); }
};
function kenoGrid(view) {
  const picks = view ? view.picks : sel.keno, drawn = view ? view.drawn : [];
  return '<div class="table-label">' + (view ? view.hits.length + " OF " + picks.length + " MATCHED" : "CHOOSE UP TO 10 NUMBERS · " + picks.length + " SELECTED") + "</div>" +
    '<div class="keno-grid">' + Array.from({ length: 80 }, (_, i) => {
      const n = i + 1, p = picks.includes(n), d = drawn.includes(n);
      return '<button type="button" class="keno-number ' + (p ? "selected " : "") + (d ? "drawn " : "") + (p && d ? "hit" : "") + '" data-keno="' + n + '">' + n + "</button>";
    }).join("") + "</div>" +
    (view ? '<p class="small-note">Tap a number to start a new selection.</p>' : "");
}

/* ---------- round renderers (view = what the server lets us see) ---------- */
const RENDER = {
  slots(v, res) {
    return '<div class="slot-reels">' + v.reels.map(col => '<div class="slot-reel">' + col.map(s => "<span>" + s + "</span>").join("") + "</div>").join("") + "</div>" + banner(res) +
      '<p class="small-note">Centre line: ' + v.line.join(" · ") + "</p>";
  },
  roulette(v, res) { return '<div class="roulette-wheel ' + v.colour + '">' + v.n + "</div>" + banner(res); },
  baccarat(v, res) {
    return '<div class="table-label">PLAYER · ' + v.p + '</div><div class="card-row">' + v.player.map(card).join("") + "</div>" +
      '<div class="table-label">BANKER · ' + v.b + '</div><div class="card-row">' + v.banker.map(card).join("") + "</div>" + banner(res);
  },
  craps(v, res) {
    const last = v.rolls[v.rolls.length - 1];
    return '<div class="dice-row"><span class="die">' + last[0] + '</span><span class="die">' + last[1] + "</span></div>" +
      '<div class="table-label">' + (v.point ? "POINT " + v.point : "COME-OUT") + " · " + v.rolls.length + " ROLL" + (v.rolls.length > 1 ? "S" : "") + "</div>" +
      '<p class="small-note">Rolls: ' + v.rolls.map(r => r[0] + r[1]).join(" → ") + "</p>" + banner(res);
  },
  keno(v) { return kenoGrid(v) + banner(ui.res); },
  blackjack(v, res) {
    return '<div class="table-label">YOUR HAND · ' + v.pv + '</div><div class="card-row">' + v.player.map(card).join("") + "</div>" +
      '<div class="table-label">DEALER · ' + v.dv + (v.hiddenCard ? "+" : "") + '</div><div class="card-row">' + v.dealer.map(card).join("") + (v.hiddenCard ? hiddenCard : "") + "</div>" +
      (res.done ? banner(res) : '<div class="action-row">' + btn("HIT", "hit") + btn("STAND", "stand") + (v.canDouble ? btn("DOUBLE", "double") : "") + "</div>" + banner(res));
  },
  videopoker(v, res) {
    const live = !res.done;
    return '<div class="table-label">' + (live ? "TAP CARDS TO HOLD" : "FINAL HAND · " + esc(v.result)) + '</div><div class="card-row">' +
      v.hand.map((c, i) => '<button type="button" class="hold-card ' + (live && sel.held[i] ? "held" : "") + '" data-hold="' + i + '" ' + (live ? "" : "disabled") + ">" + card(c) + (live ? "<small>" + (sel.held[i] ? "HELD" : "HOLD") + "</small>" : "") + "</button>").join("") + "</div>" +
      (live ? '<div class="action-row">' + btn("DRAW", "draw", "start-button") + "</div>" : "") + banner(res);
  },
  poker(v, res) {
    const live = !res.done;
    return '<div class="table-label">COMMUNITY CARDS</div><div class="card-row">' + v.board.map(card).join("") + "</div>" +
      '<div class="table-label">YOUR CARDS' + (v.playerHand ? " · " + esc(v.playerHand) : "") + '</div><div class="card-row">' + v.player.map(card).join("") + "</div>" +
      '<div class="table-label">DEALER' + (v.dealerHand ? " · " + esc(v.dealerHand) : "") + '</div><div class="card-row">' + (v.dealer ? v.dealer.map(card).join("") : hiddenCard + hiddenCard) + "</div>" +
      (live ? '<div class="action-row">' + btn("RAISE +" + fmt(v.raiseCost), "raise", "start-button") + btn("FOLD", "fold") + "</div>" : "") + banner(res);
  },
  bingo(v, res) {
    const called = new Set(v.called), last = v.called.slice(-10);
    return '<div class="table-label">90-BALL TICKET · ' + v.called.length + " / " + v.maxCalls + " CALLED · " + v.lines + " LINE" + (v.lines === 1 ? "" : "S") + "</div>" +
      '<div class="bingo-grid">' + v.grid.flatMap(row => row.map(n => '<span class="bingo-cell ' + (n && called.has(n) ? "marked" : "") + '">' + (n || "") + "</span>")).join("") + "</div>" +
      '<div class="drawn-numbers">' + (last.length ? last.join(" · ") : "No numbers called yet") + "</div>" +
      (res.done ? "" : '<div class="action-row">' + btn("DRAW NEXT", "draw", "start-button") + btn("AUTO DRAW", "auto") + "</div>") + banner(res);
  },
  crash(v, res) {
    if (v.running) return '<div class="crash-display"><div class="multiplier" id="multiplier">' + v.mult.toFixed(2) + '×</div><div class="crash-track"><div class="crash-line" id="crashLine"></div></div>' + btn("CASH OUT", "cashout", "start-button") + "</div>";
    return '<div class="multiplier">' + (v.cashedAt ? v.cashedAt.toFixed(2) + "×" : "💥 " + v.crashAt.toFixed(2) + "×") + "</div>" +
      '<p class="small-note">The round ' + (v.cashedAt ? "would have crashed at " : "crashed at ") + v.crashAt.toFixed(2) + "×.</p>" + banner(res);
  }
};

function rulesCard(g) {
  return '<div class="rules-card"><div class="rules-heading">HOW THIS GAME WORKS</div><div>' + esc(ruleText[g]) + '</div><div class="small-note">Play money only · no real-money deposits, wagers or prizes</div></div>';
}
function paint() {
  const g = active;
  if (!g) return;
  let html = ui.view ? RENDER[g](ui.view, ui.res || {}) : rulesCard(g);
  if (!ui.live && SELECT[g]) html += SELECT[g]();
  $("gameStage").innerHTML = html;
  const startBtn = $("startButton");
  startBtn.disabled = ui.live || busy;
  startBtn.textContent = ui.live ? "ROUND IN PROGRESS" : ui.view ? "PLAY AGAIN ↻" : "PLACE BET ↗";
  $("saveButton").classList.toggle("hidden", !ui.live);
  $("betBar").classList.toggle("locked", ui.live);
}

/* ---------- talking to the server ---------- */
function handle(res) {
  if (res.user) { user = res.user; pending = res.done ? null : { game: res.game }; renderUser(); }
  ui.view = res.view; ui.res = res; ui.live = !res.done;
  if (res.done) {
    stopTimers(); session += res.profit; setSession();
    status(res.message);
    refreshLeaderboard();
    if (user && user.balance < user.minBet && user.bonus.rescueReady) toast("You're out of chips — claim your free top-up!");
  } else if (res.message) status(res.message);
  if (res.game === "videopoker" && !ui.live) sel.held = [false, false, false, false, false];
  paint();
  if (ui.live && res.game === "crash") startCrash(res.view);
}
async function call(url, body) {
  if (busy) return;
  busy = true; paint();
  try { handle(await api(url, { body })); }
  catch (e) { status(e.message); toast(e.message); if (/Finish your/.test(e.message)) sync(); }
  finally { busy = false; paint(); }
}
function params() {
  if (active === "roulette") return { type: sel.roulette.type, number: sel.roulette.number };
  if (active === "baccarat") return { side: sel.baccarat };
  if (active === "keno") return { picks: sel.keno };
  return {};
}
function startRound() {
  if (!active) return;
  if (!user) { showModal("Log in to place bets with your free chips."); return; }
  clampBet();
  if (bet > user.balance) { status("Not enough chips for that bet."); toast("Not enough chips — lower your bet or claim free chips."); return; }
  if (active === "keno" && !sel.keno.length) { status("Pick at least one number first."); return; }
  ui.view = null; ui.res = null;
  call("/api/casino/start", { game: active, bet, params: params() });
}
function act(action) {
  if (action === "draw" && active === "videopoker") return call("/api/casino/act", { action: "draw", params: { held: sel.held } });
  call("/api/casino/act", { action });
}

/* ---------- crash animation ---------- */
function startCrash(view) {
  stopTimers();
  crashStart = Date.now() - view.elapsed;
  crashClock = setInterval(() => {
    const m = Math.exp((Date.now() - crashStart) / 2600), el = $("multiplier");
    if (!el) return;
    el.textContent = m.toFixed(2) + "×"; $("crashLine").style.width = Math.min(100, (m - 1) * 13) + "%";
  }, 50);
  crashPoll = setInterval(async () => {
    if (polling || busy) return;
    polling = true;
    try {
      const res = await api("/api/casino/act", { body: { action: "poll" } });
      if (res.done) handle(res); else crashStart = Date.now() - res.view.elapsed;
    } catch (e) { /* try again on the next tick */ }
    finally { polling = false; }
  }, 400);
}

/* ---------- opening / closing games ---------- */
function openGame(id) {
  if (!games[id]) return;
  stopTimers(); active = id; ui = { view: null, res: null, live: false }; session = 0; setSession();
  $("gameGrid").classList.add("hidden"); $("playArea").classList.remove("hidden");
  $("gameTitle").textContent = games[id][0]; $("gameDescription").textContent = games[id][1];
  $("gameKicker").textContent = "PLAY-MONEY TABLE"; $("gameTag").textContent = "NO REAL MONEY";
  status(games[id][2]);
  paint();
  if (pending && pending.game === id) resume(); else if (pending) status("You have an unfinished " + (games[pending.game] ? games[pending.game][0] : "") + " round — open it to continue.");
  $("playArea").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function resume() {
  try {
    const d = await api("/api/me");
    user = d.user; pending = d.active; renderUser();
    if (d.active && d.active.game === active) handle({ done: false, game: active, view: d.active.view, message: "Resuming your round.", user });
  } catch (e) { status(e.message); }
}

/* ---------- events ---------- */
$("gameGrid").addEventListener("click", e => { const b = e.target.closest("[data-game]"); if (b) openGame(b.dataset.game); });
$("gameStage").addEventListener("click", e => {
  const hold = e.target.closest("[data-hold]");
  if (hold && ui.live && active === "videopoker") { const i = Number(hold.dataset.hold); sel.held[i] = !sel.held[i]; paint(); return; }
  const k = e.target.closest("[data-keno]");
  if (k && !ui.live && active === "keno") {
    if (ui.view) { ui = { view: null, res: null, live: false }; sel.keno = []; }
    const n = Number(k.dataset.keno);
    if (sel.keno.includes(n)) sel.keno = sel.keno.filter(x => x !== n); else if (sel.keno.length < 10) sel.keno.push(n);
    paint(); return;
  }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = b.dataset.act;
  if (a.startsWith("rt:")) { sel.roulette.type = a.slice(3); paint(); return; }
  if (a.startsWith("bs:")) { sel.baccarat = a.slice(3); paint(); return; }
  act(a);
});
$("gameStage").addEventListener("input", e => {
  if (e.target.id === "rouletteNumber") { sel.roulette.number = Math.max(0, Math.min(36, Math.floor(Number(e.target.value) || 0))); sel.roulette.type = "straight"; }
});
$("betBar").addEventListener("click", e => {
  const b = e.target.closest("[data-bet]");
  if (!b || ui.live) return;
  const v = b.dataset.bet;
  if (v === "max") bet = user ? Math.min(user.maxBet, user.balance) : 10000;
  else if (v === "half") bet = Math.floor(bet / 2);
  else if (v === "double") bet = bet * 2;
  else bet = Number(v);
  clampBet();
});
$("betInput").addEventListener("change", e => { bet = Number(e.target.value); clampBet(); });
$("startButton").onclick = startRound;
$("saveButton").onclick = async () => {
  if (!ui.live || busy) return;
  if (!confirm("Forfeit this round? Your stake is lost.")) return;
  stopTimers();
  await call("/api/casino/forfeit", {});
};
$("backButton").onclick = () => {
  if (ui.live && !confirm("Your round is still in progress. You can come back to it later. Leave the table?")) return;
  stopTimers(); active = null;
  $("playArea").classList.add("hidden"); $("gameGrid").classList.remove("hidden");
};
$("bonusButton").onclick = async () => {
  try {
    const d = await api("/api/wallet/claim", { body: {} });
    user = d.user; renderUser(); toast(d.message);
  } catch (e) { toast(e.message); }
};
$("accountButton").onclick = () => {
  if (!user) { showModal(); return; }
  if (confirm("Log out of " + user.username + "?")) api("/api/logout", { method: "POST", body: {} }).then(() => { user = null; pending = null; stopTimers(); renderUser(); sync(); }).catch(() => status("Could not log out. Try again."));
};
$("closeModal").onclick = () => $("modal").classList.add("hidden");
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("modal").classList.contains("hidden")) $("modal").classList.add("hidden"); });
$("modal").onclick = e => { if (e.target.dataset.close) $("modal").classList.add("hidden"); };
$("loginTab").onclick = () => setAuthMode("login");
$("registerTab").onclick = () => setAuthMode("register");
$("username").addEventListener("input", e => { const p = e.target.selectionStart; e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""); e.target.setSelectionRange(p, p); });
$("authForm").onsubmit = async e => {
  e.preventDefault(); $("authError").textContent = "";
  const submit = $("authSubmit"); submit.disabled = true;
  try {
    const d = await api("/api/" + authMode, { body: { username: $("username").value.trim(), password: $("password").value } });
    user = d.user; pending = null; renderUser(); $("modal").classList.add("hidden"); $("authForm").reset();
    await refreshLeaderboard();
    if (authMode === "register") toast("Welcome! You start with " + fmt(user.balance) + " free chips.");
    if (active) paint();
  } catch (err) { $("authError").textContent = err.message; }
  finally { submit.disabled = false; setAuthMode(authMode); }
};
(async () => { clampBet(); await sync(); await refreshLeaderboard(); })();
