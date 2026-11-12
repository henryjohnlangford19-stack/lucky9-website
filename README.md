# LUCKY 9 — Online arcade game

A multiplayer-ready, account-based version of LUCKY 9. Players share one global leaderboard.

## Requirements
- Node.js 20 or newer
- npm

## Run locally
1. Extract the ZIP.
2. Open a terminal in the `lucky9-website` folder.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Change `SESSION_SECRET` to a long random value.
6. Run `npm start`.
7. Open `http://localhost:3000`.

## Gameplay
- Each round has 9 tiles: 8 gems and 1 hidden bomb.
- Gem values grow with your streak: +10, +20, +30, and so on.
- Bank points to protect them and move to the next round.
- Hit the bomb and lose only the current round's unbanked points.
- Find all 8 gems to receive a round-scaled completion bonus; the perfect round is banked automatically.
- Cash out to save your run score to the global leaderboard and earn XP.
- Levels are based on XP. The first milestone is a 100-point best run.

## Accounts and security
- Usernames are normalized to lowercase and restricted to 3–16 lowercase letters, digits, or underscores.
- Usernames are unique, including case-insensitive uniqueness in SQLite.
- Passwords are hashed with bcrypt; plaintext passwords are never stored.
- Login/register requests are rate-limited.
- Sessions use an SQLite-backed session store and HTTP-only, same-site cookies.
- Game picks and score calculations happen on the server, not in browser JavaScript.

## Put it online so other people can play
This project includes a Render Blueprint in `render.yaml`.

1. Create a private GitHub repository and upload the project files.
2. In Render, choose **New → Blueprint** and connect that repository.
3. Render reads `render.yaml`, creates the Node web service, generates a session secret, and provisions a persistent disk mounted at `data`.
4. Deploy. Render provides a public HTTPS URL to share with players.

The persistent disk is essential: the SQLite database and login sessions are stored in `data`. Do not remove it if you want accounts and scores to survive deploys. The included `/api/health` endpoint is used for deployment health checks.

For a larger public launch, move to managed PostgreSQL and a shared session store, enable database backups, add email-based account recovery, and consider additional abuse prevention. This starter is intended for a small community launch.
