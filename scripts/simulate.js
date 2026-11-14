// Estimates each game's return-to-player (RTP). Run: npm run simulate
const { engines, KENO_PAYS } = require("../casino");
const N = Number(process.argv[2] || 200000);
const BET = 100;

function run(name, round) {
  let wagered = 0, returned = 0;
  for (let i = 0; i < N; i++) { const [w, r] = round(); wagered += w; returned += r; }
  console.log(name.padEnd(28), ((returned / wagered) * 100).toFixed(2) + "% RTP");
}
const single = (game, params) => () => { const r = engines[game].start(BET, params); return [BET, r.payout]; };

run("Slots", single("slots", {}));
run("Roulette (red)", single("roulette", { type: "red" }));
run("Roulette (straight 17)", single("roulette", { type: "straight", number: 17 }));
run("Baccarat (player)", single("baccarat", { side: "player" }));
run("Baccarat (banker)", single("baccarat", { side: "banker" }));
run("Baccarat (tie)", single("baccarat", { side: "tie" }));
run("Craps (pass line)", single("craps", {}));
run("Bingo", () => { let r = engines.bingo.start(BET, {}); r = engines.bingo.act(r.state, "auto", {}); return [BET, r.payout]; });

// Keno: exact maths
const C = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
for (let s = 1; s <= 10; s++) {
  let rtp = 0;
  for (const [h, m] of Object.entries(KENO_PAYS[s])) rtp += (C(s, h) * C(80 - s, 20 - h) / C(80, 20)) * m;
  console.log(`Keno ${s}-spot (exact)`.padEnd(28), (rtp * 100).toFixed(2) + "% RTP");
}

// Blackjack: hit below 17, never double (a simple player)
run("Blackjack (stand on 17)", () => {
  let r = engines.blackjack.start(BET, {}), wager = BET;
  while (!r.done) { const v = require("../casino").bjValue(r.state.player); r = engines.blackjack.act(r.state, v < 17 ? "hit" : "stand", {}); }
  return [wager, r.payout];
});
// Video poker: hold made hands (pairs or better), otherwise hold high cards J+, otherwise draw five
run("Video poker (simple play)", () => {
  let r = engines.videopoker.start(BET, {});
  const hand = r.state.hand, counts = {};
  hand.forEach(c => { counts[c.v] = (counts[c.v] || 0) + 1; });
  const rk = require("../casino").rank5(hand);
  let held = hand.map(c => counts[c.v] > 1);
  if (rk.cat >= 4) held = hand.map(() => true);
  else if (!held.some(Boolean)) held = hand.map(c => c.v >= 11);
  r = engines.videopoker.act(r.state, "draw", { held });
  return [BET, r.payout];
});
// Hold'em: always raise
run("Hold'em (always raise)", () => {
  let r = engines.poker.start(BET, {});
  r = engines.poker.act(r.state, "raise", {});
  return [BET * 3, r.payout];
});
console.log("Multiplier Lab".padEnd(28), "97.00% RTP (by construction, any cash-out target)");
