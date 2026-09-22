# Iorio Reloaded — Options Trading System

## What this is
Multi-strategy options trading platform used by two people: Marce (Marcelo), the developer, and Juan, a non-developer business/trading-domain user. Node.js backend, React frontend, Postgres (Heroku, Essential-1 plan), hosted on Heroku (separate front-end/back-end apps, backend on a Basic web dyno, frontend on Eco). Strategies built: covered calls and cash-secured puts.

## Working agreements (do not deviate without asking)
- **Ask before deciding.** Never assume design, behaviour, or approach. Always present a recommendation with pros/cons/caveats and let the user choose.
- **Formulas require explicit sign-off.** Before implementing any financial calculation, present the formula for approval. Do not implement until approved.
- **Test everything end-to-end, no assumptions.** DB writes/reads must be verified directly. Every API endpoint must be tested for correct store + retrieve. Every screen must be tested with the Playwright MCP, issues fixed before considered done.
- **Pushing (updated 2026-09-21, user-authorised once staging existed).** Claude may `git push origin main` to GitHub for both repos (`iorio-reloaded-api`, `iorio-reloaded-app`): `main` auto-deploys to the *staging* apps only; the old prod apps have auto-deploy off and prod is promotion-only. Still never: force-push, push to Heroku git remotes, promote/deploy to production, or push work that isn't finished and verified. Commits when asked; announce every push and what it will deploy.
- **CLI commands**: ask permission, then run them yourself rather than asking the user to run them.
- **Communication.** Marce is the developer, so technical depth is fine with him. Anything Juan will read (PROGRESS.md entries, summaries) should lead with a plain-language summary and explain technical concepts in plain terms.
- **Push back** on requests that would degrade the system technically or hurt scalability — this user wants pushback, not compliance.
- **No over-engineering.** Build only what's needed for the system to work now. Surface optional/future features separately (see PROGRESS.md) rather than building them speculatively.
- **Strategies are code, not config.** New strategies are implemented in code, not built through the UI. The data schema and platform code must support multiple strategies running in parallel as part of one book, but strategy logic itself is not generalized/abstracted preemptively.
- **Naming**: long, descriptive variable/function names — no cryptic abbreviations. Shared formatting/parsing/presentation logic goes into a reusable library, not duplicated inline.
- **Parallelize** operations where possible. Long-running operations that risk Heroku's request timeout must use SSE streaming rather than blocking requests.
- **Data tables**: every data table gets a gear icon above it opening a popover with per-column show/hide checkboxes. All columns visible by default. Selections auto-save to localStorage (no explicit save button).
- **Personalization** (column visibility, UI prefs) is localStorage-only — no per-user server-side settings. All users share the same access level.
- **Mobile + desktop**: every screen and function must work on both. Test both explicitly (Playwright viewport testing).

## Progress tracking
See `PROGRESS.md` in this repo for: what's planned, what's built, current state of each component, and a running list of optional/future features awaiting a decision. Update it as work happens — this is the persistent memory of the project across sessions.
