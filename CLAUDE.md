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
- **Personalization** (column visibility, UI prefs) is localStorage-only — no per-user server-side settings.
- **Access levels** (2026-10-17): `admin` (Marce, and Pluto's service account) can do everything; `trader` (everyone else, the default for new users) cannot change risk limits or Pluto, start or resume Pluto, lift a trading halt, remove a Shortlist ticker Pluto is switched on for (any other ticker without open positions they can remove, 2026-11-05) or restart the Gateway, and its opening/rolling orders are held to the Manual book's available cash and kept off Pluto's tickers (`src/lib/sessionUser.ts`, `src/books/bookFigures.ts`); splitting deposits and moving cash between the books are admin-only (2026-11-05). The server enforces every rule; the screens only mirror them. Backtesting (the lab, suitability flags) has no access levels: it runs only on Marce's Mac. Set with `npm run manage-user -- set-access-level`, read from `users` on every request. Genosuke cannot trade.
- **Mobile + desktop**: every screen and function must work on both. Test both explicitly (Playwright viewport testing).
- **Pluto's How it works tab**: the Pluto screen explains each execution strategy in plain language (app `src/components/pluto/PlutoHowItWorksTab.tsx`), with every number from `GET /pluto/how-it-works` (`src/pluto/howItWorks.ts`). A change to a rule, setting or constant the tab describes updates the tab's wording, and the endpoint if a new number is quoted, in the same change. `src/pluto/howItWorks.test.ts` pins every quoted number: when it fails, check the tab's wording against the new value before updating the expectation.

## Logs
Use Better Stack, not `heroku logs` (whose buffer holds only an hour or two). Both API apps (`iorio-staging-api`, `iorio-reloaded-api`) have it; `iorio-staging-app` has a drain only, no SQL access. It is a ClickHouse HTTP endpoint queried with curl:
- Credentials: `BETTERSTACK_SQL_HOST`, `BETTERSTACK_SQL_USERNAME`, `BETTERSTACK_SQL_PASSWORD`, `BETTERSTACK_SOURCE_TABLE` in the app's config. Fetch each with `heroku config:get` into shell variables inside the same command; never print `heroku config` (it shows the password).
- The table must be wrapped, or the query fails with misleading UNKNOWN_TABLE / ACCESS_DENIED errors: `FROM remote(${TABLE}_logs)` for the last hour or so, `FROM s3Cluster(primary, ${TABLE}_s3) WHERE _row_type = 1` for anything older.
- Each row's `raw` is JSON: `JSONExtractString(raw, 'message')`; router fields under `raw.heroku` (`JSONExtractString(raw, 'heroku', 'path')`).
- Example: `curl -sS -u "$BS_USER:$BS_PASS" --data-urlencode "query=SELECT dt, JSONExtractString(raw,'message') AS msg FROM s3Cluster(primary, ${BS_TABLE}_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 1 DAY AND msg ILIKE '%text%' ORDER BY dt DESC LIMIT 200 FORMAT JSONEachRow" "https://$BS_HOST:443/"`

## Progress tracking
See `PROGRESS.md` in this repo for: what's planned, what's built, current state of each component, and a running list of optional/future features awaiting a decision. Update it as work happens — this is the persistent memory of the project across sessions.
