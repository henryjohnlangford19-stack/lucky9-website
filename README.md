# LUCKY 9 — Online arcade game

A play-money casino arcade. Players share one global leaderboard (richest players).

## Run locally
1. Install Node.js 20 or newer.
2. Create a free PostgreSQL project with Neon.
3. Copy the pooled connection string from Neon into `.env` as `DATABASE_URL`.
4. Copy `.env.example` to `.env` and set a long random `SESSION_SECRET`.
5. Run `npm install`, then `npm start`.
6. Open `http://localhost:3000`.

## Play-money casino
Ten games using free chips (no real money, ever). New players start with **10,000 chips**; bets run from 10 to 10,000.

| Game | House edge (approx. return) |
|---|---|
| Neon Reels (slots) | 91% |
| Blackjack | 99% with good play (3:2 blackjack, dealer stands on 17) |
| European Roulette | 97.3% |
| Texas Hold'em (Casino Hold'em rules) | ~98.7% always-raise |
| Baccarat | 98.7% Player / 98.8% Banker / 84% Tie |
| Jacks or Better video poker | 93%+ simple play, ~98% optimal |
| Craps (Pass Line) | 98.6% |
| 90-Ball Bingo | 91% |
| Keno 80 | ~90-93% |
| Multiplier Lab (crash) | 97% |

Run `npm run simulate` to re-measure these.

### How the wallet works
- **The server is the boss.** The browser only says "bet 100 on slots". The server checks the balance, shuffles/rolls with `crypto.randomInt`, decides the result and pays out. Nothing the browser sends can change a result or a score.
- **One database transaction per step.** The user row is locked (`FOR UPDATE`), the bet is taken and the payout paid together, so a crash or a double-tap can't lose or duplicate chips.
- **Ledger.** Every bet, payout and bonus is a row in `transactions` with the balance afterwards; `users.balance` has a `CHECK (balance >= 0)`.
- **Unfinished rounds** (blackjack, video poker, Hold'em, bingo, crash) are stored in `active_games`, so a refresh or a lost connection resumes the round. Players can also forfeit.
- **Free chips.** +2,000 daily bonus (24h cooldown, first one 24h after sign-up) and a +1,000 top-up when you're below the minimum bet (30 min cooldown).

Tables are created automatically on startup (`users`, `transactions`, `active_games`, sessions). Existing accounts keep their data and get a 10,000-chip balance.

## Accounts and security
- Usernames are lowercase and restricted to 3-16 letters, digits, or underscores.
- Passwords are hashed with bcrypt; plaintext passwords are never stored.
- Login/register and betting requests are rate-limited.
- Sessions, accounts, wallets and ledgers are stored in PostgreSQL.

## Free deployment
This project includes a Render Blueprint configured for a **Free** web service. It intentionally has no paid compute plan and no persistent disk.

The database is separate and uses Neon PostgreSQL. The Neon Free plan has finite usage limits and can suspend compute when a limit is reached, but the database contents remain stored. Set the Neon pooled connection string as the Render service's `DATABASE_URL` secret environment variable. Do not paste it into GitHub or public messages.

1. Create a Neon project on its Free plan and copy its pooled connection string.
2. In Render, create a Blueprint from this repository.
3. When prompted, enter the Neon connection string for `DATABASE_URL`.
4. Review the resources and confirm the web service is on the Free plan before applying.
5. After deployment, open the Render URL and test account creation, a run, cash-out, and the leaderboard.

The free Render web service may sleep when idle and take around a minute to wake. Free-tier services are suitable for testing and hobby use, not guaranteed production uptime. Check provider usage limits and terms before inviting a large audience.
