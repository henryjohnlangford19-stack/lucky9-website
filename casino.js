"use strict";
// LUCKY 9 casino engines. Everything random or money-related happens here, on the server.
// Interface per game:
//   start(bet, params) -> { state, done, payout?, message, extraBet? }
//   act(state, action, params) -> same shape (only for multi-step games)
//   view(state, done)  -> what the browser is allowed to see
//   forfeit(state)     -> payout when a player abandons a round (default 0)
// `payout` is the TOTAL returned to the player (stake included). 0 = lost.

const { randomInt } = require("crypto");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MIN_BET = 10;
const MAX_BET = 10000;

const rnd = n => randomInt(0, n);
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickWeighted(table) {
  let r = rnd(table.reduce((sum, row) => sum + row[1], 0));
  for (const [value, weight] of table) { if (r < weight) return value; r -= weight; }
}
const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
function newDeck() {
  return shuffle(SUITS.flatMap(s => RANKS.map((r, i) => ({ r, s, v: i === 0 ? 14 : i + 1 }))));
}

/* ---------- poker hand ranking (5 cards, and best 5 of 7) ---------- */
function rank5(cards) {
  const values = cards.map(c => c.v).sort((a, b) => b - a);
  const counts = {};
  values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const groups = Object.entries(counts).map(([v, n]) => [Number(v), n]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(c => c.s === cards[0].s);
  let straightHigh = 0;
  if (new Set(values).size === 5) {
    if (values[0] - values[4] === 4) straightHigh = values[0];
    else if (values[0] === 14 && values[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  let tb = groups.map(g => g[0]);
  let cat, name;
  if (flush && straightHigh) { cat = straightHigh === 14 ? 9 : 8; name = cat === 9 ? "Royal Flush" : "Straight Flush"; tb = [straightHigh]; }
  else if (groups[0][1] === 4) { cat = 7; name = "Four of a Kind"; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { cat = 6; name = "Full House"; }
  else if (flush) { cat = 5; name = "Flush"; }
  else if (straightHigh) { cat = 4; name = "Straight"; tb = [straightHigh]; }
  else if (groups[0][1] === 3) { cat = 3; name = "Three of a Kind"; }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { cat = 2; name = "Two Pair"; }
  else if (groups[0][1] === 2) { cat = 1; name = "One Pair"; }
  else { cat = 0; name = "High Card"; }
  return { cat, name, tb, key: [cat, ...tb] };
}
function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
function best7(cards) {
  let best = null;
  const pick = (start, chosen) => {
    if (chosen.length === 5) {
      const r = rank5(chosen);
      if (!best || compareKeys(r.key, best.key) > 0) best = r;
      return;
    }
    for (let i = start; i < cards.length; i++) pick(i + 1, chosen.concat(cards[i]));
  };
  pick(0, []);
  return best;
}

/* ---------- Neon Reels (slots) ---------- */
const SLOT_SYMBOLS = [["🍒", 28], ["🍋", 24], ["🔔", 18], ["⭐", 12], ["💎", 8], ["7️⃣", 5], ["🃏", 5]];
const SLOT_PAYS = { "🍒": [4, 9, 27], "🍋": [5, 14, 45], "🔔": [9, 22, 72], "⭐": [14, 36, 135], "💎": [22, 63, 270], "7️⃣": [45, 135, 720] };
function slotLine(line) {
  const target = line.find(s => s !== "🃏");
  if (!target) return { sym: "🃏", run: 5, mult: 900 };
  let run = 0;
  for (const s of line) { if (s === target || s === "🃏") run++; else break; }
  return { sym: target, run, mult: run >= 3 ? SLOT_PAYS[target][run - 3] : 0 };
}
const slots = {
  name: "Neon Reels",
  start(bet) {
    const reels = Array.from({ length: 5 }, () => [0, 1, 2].map(() => pickWeighted(SLOT_SYMBOLS)));
    const line = reels.map(r => r[1]);
    const { sym, run, mult } = slotLine(line);
    return {
      state: { reels, line, run, mult }, done: true, payout: Math.floor(bet * mult),
      message: mult ? `${run} × ${sym} on the centre line — pays ${mult}×!` : "No winning line this spin."
    };
  },
  view: state => state
};

/* ---------- European roulette ---------- */
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const ROULETTE_BETS = {
  red: [n => REDS.has(n), 2], black: [n => n > 0 && !REDS.has(n), 2],
  odd: [n => n > 0 && n % 2 === 1, 2], even: [n => n > 0 && n % 2 === 0, 2],
  low: [n => n >= 1 && n <= 18, 2], high: [n => n >= 19, 2],
  dozen1: [n => n >= 1 && n <= 12, 3], dozen2: [n => n >= 13 && n <= 24, 3], dozen3: [n => n >= 25, 3]
};
const roulette = {
  name: "European Roulette",
  start(bet, params) {
    const type = String(params.type || "");
    let test, mult, label;
    if (type === "straight") {
      const target = Number(params.number);
      if (!Number.isInteger(target) || target < 0 || target > 36) throw new HttpError(400, "Pick a number from 0 to 36.");
      test = n => n === target; mult = 36; label = `number ${target}`;
    } else if (ROULETTE_BETS[type]) {
      [test, mult] = ROULETTE_BETS[type]; label = type;
    } else throw new HttpError(400, "Choose a roulette bet first.");
    const n = rnd(37);
    const colour = n === 0 ? "green" : REDS.has(n) ? "red" : "black";
    const won = test(n);
    return {
      state: { n, colour, bet: label, won }, done: true, payout: won ? bet * mult : 0,
      message: `${n} ${colour.toUpperCase()}. ${won ? `Your ${label} bet wins ${mult - 1}:1!` : `Your ${label} bet loses.`}`
    };
  },
  view: state => state
};

/* ---------- Baccarat ---------- */
const bacVal = cards => cards.reduce((t, c) => t + (c.v >= 10 && c.v <= 13 ? 0 : c.v === 14 ? 1 : c.v), 0) % 10;
const baccarat = {
  name: "Baccarat",
  start(bet, params) {
    const side = String(params.side || "");
    if (!["player", "banker", "tie"].includes(side)) throw new HttpError(400, "Choose Player, Banker or Tie.");
    const d = newDeck();
    const P = [d.pop(), d.pop()], B = [d.pop(), d.pop()];
    if (bacVal(P) < 8 && bacVal(B) < 8) {
      let third = null;
      if (bacVal(P) <= 5) { third = d.pop(); P.push(third); }
      const b = bacVal(B);
      let draw;
      if (!third) draw = b <= 5;
      else {
        const x = bacVal([third]);
        draw = b <= 2 || (b === 3 && x !== 8) || (b === 4 && x >= 2 && x <= 7) || (b === 5 && x >= 4 && x <= 7) || (b === 6 && x >= 6 && x <= 7);
      }
      if (draw) B.push(d.pop());
    }
    const p = bacVal(P), b = bacVal(B);
    const result = p > b ? "player" : b > p ? "banker" : "tie";
    let payout = 0;
    if (result === "tie") payout = side === "tie" ? bet * 9 : bet; // Player/Banker bets push on a tie
    else if (side === result) payout = result === "player" ? bet * 2 : Math.floor(bet * 1.95); // 5% commission on Banker
    return {
      state: { player: P, banker: B, p, b, result, side }, done: true, payout,
      message: `${result.toUpperCase()} ${result === "tie" ? "— tie" : "wins"} (${p} v ${b}). ` + (payout > bet ? "You win!" : payout === bet ? "Push — stake returned." : "Your bet loses.")
    };
  },
  view: state => state
};

/* ---------- Keno 80 ---------- */
// Multipliers (total return per 1 staked) by spots picked -> hits. Tuned to roughly 90% return.
const KENO_PAYS = {
  1: { 1: 3.7 },
  2: { 2: 15 },
  3: { 2: 3.7, 3: 30 },
  4: { 2: 1.7, 3: 7, 4: 75 },
  5: { 3: 6.8, 4: 22, 5: 140 },
  6: { 3: 3.8, 4: 9.6, 5: 38, 6: 275 },
  7: { 3: 2.5, 4: 5.3, 5: 16, 6: 74, 7: 610 },
  8: { 4: 5.8, 5: 15, 6: 52, 7: 275, 8: 2550 },
  9: { 4: 3.8, 5: 8.3, 6: 24, 7: 99, 8: 600, 9: 5000 },
  10: { 5: 9.1, 6: 23, 7: 77, 8: 360, 9: 2450, 10: 5000 }
};
const keno = {
  name: "Keno 80",
  start(bet, params) {
    const picks = Array.isArray(params.picks) ? [...new Set(params.picks.map(Number))] : [];
    if (picks.length < 1 || picks.length > 10 || picks.some(n => !Number.isInteger(n) || n < 1 || n > 80)) throw new HttpError(400, "Pick between 1 and 10 numbers from 1 to 80.");
    const drawn = shuffle(range(1, 80)).slice(0, 20).sort((a, b) => a - b);
    const hits = picks.filter(n => drawn.includes(n));
    const mult = KENO_PAYS[picks.length][hits.length] || 0;
    return {
      state: { picks, drawn, hits }, done: true, payout: Math.floor(bet * mult),
      message: `${hits.length} of ${picks.length} numbers matched. ` + (mult ? `Pays ${mult}×!` : "No prize this time.")
    };
  },
  view: state => state
};

/* ---------- Craps (Pass Line) ---------- */
const craps = {
  name: "Craps",
  start(bet) {
    const rolls = [];
    let point = null, won = false;
    for (;;) {
      const x = rnd(6) + 1, y = rnd(6) + 1, t = x + y;
      rolls.push([x, y]);
      if (point === null) {
        if (t === 7 || t === 11) { won = true; break; }
        if (t === 2 || t === 3 || t === 12) break;
        point = t;
      } else if (t === point) { won = true; break; }
      else if (t === 7) break;
    }
    return {
      state: { rolls, point, won }, done: true, payout: won ? bet * 2 : 0,
      message: won ? "Pass Line wins!" : (point === null ? "Craps — Pass Line loses." : "Seven-out — Pass Line loses.")
    };
  },
  view: state => state
};

/* ---------- Multiplier Lab (crash) ---------- */
const crashMultiplier = ms => Math.exp(Math.max(0, ms) / 2600);
const crash = {
  name: "Multiplier Lab",
  start(bet) {
    const u = randomInt(0, 1000000) / 1000000;
    const crashAt = Math.min(10000, Math.max(1, Math.floor(97 / (1 - u)) / 100)); // ~97% return
    return { state: { crashAt, startedAt: Date.now(), bet }, done: false, message: "Round running — hit CASH OUT before it crashes!" };
  },
  act(state, action) {
    const elapsed = Date.now() - state.startedAt;
    const m = crashMultiplier(elapsed);
    if (m >= state.crashAt) return { state, done: true, payout: 0, message: `Crashed at ${state.crashAt.toFixed(2)}×. Your stake is lost.` };
    if (action === "cashout") {
      const payout = Math.floor(state.bet * m);
      state.cashedAt = Math.floor(m * 100) / 100;
      return { state, done: true, payout, message: `Cashed out at ${state.cashedAt.toFixed(2)}×!` };
    }
    return { state, done: false, message: "" };
  },
  view(state, done) {
    const elapsed = Date.now() - state.startedAt;
    if (!done) return { running: true, elapsed, mult: Math.floor(crashMultiplier(elapsed) * 100) / 100 };
    return { running: false, crashAt: state.crashAt, cashedAt: state.cashedAt || null };
  }
};

/* ---------- Blackjack ---------- */
const bjValue = cards => {
  let total = 0, aces = 0;
  for (const c of cards) { if (c.v === 14) { total += 11; aces++; } else total += c.v > 10 ? 10 : c.v; }
  while (total > 21 && aces) { total -= 10; aces--; }
  return total;
};
function bjSettle(state, message) {
  while (bjValue(state.dealer) < 17) state.dealer.push(state.deck.pop()); // dealer stands on all 17s
  const p = bjValue(state.player), d = bjValue(state.dealer);
  let payout, text;
  if (d > 21) { payout = state.bet * 2; text = "Dealer busts — you win!"; }
  else if (p > d) { payout = state.bet * 2; text = "Your hand wins!"; }
  else if (p === d) { payout = state.bet; text = "Push — stake returned."; }
  else { payout = 0; text = "Dealer wins."; }
  return { state, done: true, payout, message: message || text };
}
const blackjack = {
  name: "Blackjack 21",
  start(bet) {
    const deck = newDeck();
    const state = { deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], bet };
    const pBJ = bjValue(state.player) === 21, dBJ = bjValue(state.dealer) === 21;
    if (pBJ && dBJ) return { state, done: true, payout: bet, message: "Both have Blackjack — push." };
    if (pBJ) return { state, done: true, payout: Math.floor(bet * 2.5), message: "BLACKJACK! Pays 3:2." };
    if (dBJ) return { state, done: true, payout: 0, message: "Dealer has Blackjack." };
    return { state, done: false, message: "Hit, stand or double down." };
  },
  act(state, action) {
    if (action === "hit") {
      state.player.push(state.deck.pop());
      const v = bjValue(state.player);
      if (v > 21) return { state, done: true, payout: 0, message: "You bust." };
      if (v === 21) return bjSettle(state);
      return { state, done: false, message: "" };
    }
    if (action === "stand") return bjSettle(state);
    if (action === "double") {
      if (state.player.length !== 2) throw new HttpError(400, "You can only double on your first two cards.");
      const extra = state.bet;
      state.bet *= 2;
      state.player.push(state.deck.pop());
      const result = bjValue(state.player) > 21 ? { state, done: true, payout: 0, message: "You bust on the double." } : bjSettle(state);
      result.extraBet = extra;
      return result;
    }
    throw new HttpError(400, "Unknown action.");
  },
  view(state, done) {
    return {
      player: state.player, pv: bjValue(state.player),
      dealer: done ? state.dealer : [state.dealer[0]], dv: done ? bjValue(state.dealer) : bjValue([state.dealer[0]]),
      hiddenCard: !done, canDouble: !done && state.player.length === 2
    };
  },
  forfeit: () => 0
};

/* ---------- Jacks or Better video poker ---------- */
const VP_PAYS = { "One Pair": 1, "Two Pair": 2, "Three of a Kind": 3, "Straight": 4, "Flush": 6, "Full House": 9, "Four of a Kind": 25, "Straight Flush": 50, "Royal Flush": 250 };
const videopoker = {
  name: "Jacks or Better",
  start(bet) {
    const deck = newDeck();
    return { state: { deck, hand: deck.splice(0, 5), bet }, done: false, message: "Tap the cards you want to keep, then draw." };
  },
  act(state, action, params) {
    if (action !== "draw") throw new HttpError(400, "Unknown action.");
    const held = Array.isArray(params.held) ? params.held.slice(0, 5).map(Boolean) : [];
    for (let i = 0; i < 5; i++) if (!held[i]) state.hand[i] = state.deck.pop();
    const r = rank5(state.hand);
    state.result = r.name;
    const qualifies = r.cat > 1 || (r.cat === 1 && r.tb[0] >= 11); // pair of Jacks or better
    const mult = qualifies ? VP_PAYS[r.name] : 0;
    return { state, done: true, payout: state.bet * mult, message: mult ? `${r.name} pays ${mult}×!` : `${r.name} — no win.` };
  },
  view: (state, done) => ({ hand: state.hand, result: done ? state.result : null })
};

/* ---------- Texas Hold'em vs the dealer (Casino Hold'em rules) ---------- */
const ANTE_BONUS = { 4: 1, 5: 1.5, 6: 3, 7: 10, 8: 20, 9: 100 };
const poker = {
  name: "Texas Hold'em",
  start(bet) {
    const deck = newDeck();
    const state = { deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], board: [deck.pop(), deck.pop(), deck.pop()], ante: bet };
    return { state, done: false, message: "Flop dealt. Raise (2× your ante) to see the turn and river, or fold." };
  },
  act(state, action) {
    if (action === "fold") return { state, done: true, payout: 0, message: "You folded and lose your ante." };
    if (action !== "raise") throw new HttpError(400, "Unknown action.");
    const ante = state.ante, raise = ante * 2;
    state.board.push(state.deck.pop(), state.deck.pop());
    const p = best7(state.player.concat(state.board)), d = best7(state.dealer.concat(state.board));
    state.playerHand = p.name; state.dealerHand = d.name; state.showdown = true;
    const qualifies = d.cat >= 2 || (d.cat === 1 && d.tb[0] >= 4); // dealer needs a pair of 4s or better
    const cmp = compareKeys(p.key, d.key);
    const bonus = qualifies && cmp > 0 ? Math.floor(ante * (ANTE_BONUS[p.cat] || 0)) : 0;
    let payout, text;
    if (!qualifies) { payout = ante * 2 + raise + bonus; text = "Dealer doesn't qualify — ante wins, raise is returned."; }
    else if (cmp > 0) { payout = ante * 2 + raise * 2 + bonus; text = `You win with ${p.name}!`; }
    else if (cmp === 0) { payout = ante + raise; text = "Tie — all bets returned."; }
    else { payout = 0; text = `Dealer wins with ${d.name}.`; }
    return { state, done: true, payout, extraBet: raise, message: text };
  },
  view(state, done) {
    return {
      player: state.player, board: state.board, ante: state.ante, raiseCost: state.ante * 2,
      dealer: state.showdown || done ? state.dealer : null,
      playerHand: state.playerHand || null, dealerHand: state.dealerHand || null
    };
  }
};

/* ---------- 90-ball Bingo ---------- */
const BINGO_MAX_CALLS = 60;
const BINGO_PRIZES = [0, 2, 6, 80]; // total return multiple for: nothing, one line, two lines, full house
function bingoTicket() {
  for (;;) {
    const rows = [0, 1, 2].map(() => shuffle(range(0, 8)).slice(0, 5));
    const rowsInCol = Array.from({ length: 9 }, () => []);
    rows.forEach((cols, r) => cols.forEach(c => rowsInCol[c].push(r)));
    if (rowsInCol.some(list => list.length === 0)) continue;
    const grid = [Array(9).fill(null), Array(9).fill(null), Array(9).fill(null)];
    for (let c = 0; c < 9; c++) {
      const lo = c === 0 ? 1 : c * 10, hi = c === 8 ? 90 : c * 10 + 9;
      const numbers = shuffle(range(lo, hi)).slice(0, rowsInCol[c].length).sort((a, b) => a - b);
      rowsInCol[c].sort().forEach((r, i) => { grid[r][c] = numbers[i]; });
    }
    return grid;
  }
}
function bingoLines(state) {
  const called = new Set(state.calls.slice(0, state.n));
  return state.grid.filter(row => row.filter(Boolean).every(v => called.has(v))).length;
}
function bingoStep(state, count) {
  for (let i = 0; i < count && state.n < BINGO_MAX_CALLS && bingoLines(state) < 3; i++) state.n++;
  const lines = bingoLines(state);
  const done = lines === 3 || state.n >= BINGO_MAX_CALLS;
  const payout = state.bet * BINGO_PRIZES[lines];
  const text = lines === 3 ? "FULL HOUSE!" : lines === 2 ? "Two lines" : lines === 1 ? "One line" : "No lines";
  return { state, done, payout: done ? payout : 0, message: done ? `${text} after ${state.n} calls. ` + (payout ? `Pays ${BINGO_PRIZES[lines]}×!` : "No prize.") : "" };
}
const bingo = {
  name: "90-Ball Bingo",
  start(bet) {
    const state = { grid: bingoTicket(), calls: shuffle(range(1, 90)), n: 0, bet };
    return { state, done: false, message: `Draw numbers — up to ${BINGO_MAX_CALLS} calls. One line, two lines and a full house all pay.` };
  },
  act(state, action, params) {
    if (action === "draw") return bingoStep(state, 1);
    if (action === "auto") return bingoStep(state, BINGO_MAX_CALLS);
    throw new HttpError(400, "Unknown action.");
  },
  view(state, done) {
    return { grid: state.grid, called: state.calls.slice(0, state.n), lines: bingoLines(state), maxCalls: BINGO_MAX_CALLS, done };
  },
  forfeit(state) { return state.bet * BINGO_PRIZES[bingoLines(state)]; }
};

const engines = { slots, blackjack, roulette, poker, baccarat, videopoker, craps, bingo, keno, crash };
module.exports = { engines, HttpError, MIN_BET, MAX_BET, KENO_PAYS, BINGO_PRIZES, BINGO_MAX_CALLS, VP_PAYS, rank5, best7, compareKeys, newDeck, bjValue, crashMultiplier };
