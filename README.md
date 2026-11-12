# LUCKY 9 — Online arcade game

A multiplayer-ready version of LUCKY 9. Players share one global leaderboard.

## Run locally
1. Install Node.js 20 or newer.
2. Create a free PostgreSQL project with Neon.
3. Copy the pooled connection string from Neon into `.env` as `DATABASE_URL`.
4. Copy `.env.example` to `.env` and set a long random `SESSION_SECRET`.
5. Run `npm install`, then `npm start`.
6. Open `http://localhost:3000`.

## Gameplay
- Each round has 9 tiles: 8 gems and 1 hidden bomb.
- Each gem is worth 10 more points than the previous gem in that round.
- Bank points to protect them and move to the next round.
- Hit the bomb and lose only the current round's unbanked points.
- Find all 8 gems to earn a round-scaled completion bonus; the perfect round is banked automatically.
- Cash out to save your run score to the global leaderboard and earn XP.
- Levels are based on XP.

## Accounts and security
- Usernames are lowercase and restricted to 3–16 letters, digits, or underscores.
- Passwords are hashed with bcrypt; plaintext passwords are never stored.
- Login/register requests are rate-limited.
- Sessions, accounts, scores, and XP are stored in PostgreSQL.
- Game picks and scoring happen on the server.

## Free deployment
This project includes a Render Blueprint configured for a **Free** web service. It intentionally has no paid compute plan and no persistent disk.

The database is separate and uses Neon PostgreSQL. The Neon Free plan has finite usage limits and can suspend compute when a limit is reached, but the database contents remain stored. Set the Neon pooled connection string as the Render service's `DATABASE_URL` secret environment variable. Do not paste it into GitHub or public messages.

1. Create a Neon project on its Free plan and copy its pooled connection string.
2. In Render, create a Blueprint from this repository.
3. When prompted, enter the Neon connection string for `DATABASE_URL`.
4. Review the resources and confirm the web service is on the Free plan before applying.
5. After deployment, open the Render URL and test account creation, a run, cash-out, and the leaderboard.

The free Render web service may sleep when idle and take around a minute to wake. Free-tier services are suitable for testing and hobby use, not guaranteed production uptime. Check provider usage limits and terms before inviting a large audience.
