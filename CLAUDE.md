# Iorio Reloaded — Options Trading System

## What this is
Multi-strategy options trading platform for a business user (non-developer, has a developer friend for occasional consult). Node.js backend, React frontend, Postgres (Heroku, Essential-1 plan), hosted on Heroku (separate front-end/back-end apps, Eco dynos to start). First strategy: covered calls / cash-secured puts (scope to be confirmed).

## Working agreements (do not deviate without asking)
- **Ask before deciding.** Never assume design, behaviour, or approach. Always present a recommendation with pros/cons/caveats and let the user choose.
- **Formulas require explicit sign-off.** Before implementing any financial calculation, present the formula for approval. Do not implement until approved.
- **Test everything end-to-end, no assumptions.** DB writes/reads must be verified directly. Every API endpoint must be tested for correct store + retrieve. Every screen must be tested with the Playwright MCP, issues fixed before considered done.
- **Never push code.** The user pushes to GitHub themselves. Commits are fine when asked; pushes are not.
- **CLI commands**: ask permission, then run them yourself rather than asking the user to run them (except `git push`, which is off-limits regardless).
- **Business-user communication.** Explain technical concepts in plain terms. Flag when a decision is technical enough to warrant checking with the user's developer friend — but treat that as a last resort, not a default.
- **Push back** on requests that would degrade the system technically or hurt scalability — this user wants pushback, not compliance.
- **No over-engineering.** Build only what's needed for the system to work now. Surface optional/future features separately (see PROGRESS.md) rather than building them speculatively.
- **Strategies are code, not config.** New strategies are implemented in code, not built through the UI. The data schema and platform code must support multiple strategies running in parallel as part of one book, but strategy logic itself is not generalized/abstracted preemptively.
- **Naming**: long, descriptive variable/function names — no cryptic abbreviations. Shared formatting/parsing/presentation logic goes into a reusable library, not duplicated inline.
- **Parallelize** operations where possible. Long-running operations that risk Heroku's request timeout must use SSE streaming rather than blocking requests.
- **Data tables**: every data table gets a gear icon above it opening a popover with per-column show/hide checkboxes. All columns visible by default. Selections auto-save to localStorage (no explicit save button).
- **Personalization** (column visibility, UI prefs) is localStorage-only — no per-user server-side settings. All users share the same access level.
- **Mobile + desktop**: every screen and function must work on both. Test both explicitly (Playwright viewport testing).
- **Redis (if used)**: mini plan only — avoid large objects or large volumes of small objects. Latency trade-off for cost is acceptable.

## Progress tracking
See `PROGRESS.md` in this repo for: what's planned, what's built, current state of each component, and a running list of optional/future features awaiting a decision. Update it as work happens — this is the persistent memory of the project across sessions.
