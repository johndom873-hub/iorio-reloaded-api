# Iorio Reloaded — Progress Tracker

Last updated: 2026-08-11

## Vision
Multi-strategy options trading system. Business user checks in daily, reviews suggested opportunities and open positions, approves/rejects/modifies trades. Trades execute (semi-automated) via IBKR once confirmed. Node.js + React + Postgres, hosted on Heroku.

## Status: Pre-architecture — no code written yet

## Open decisions (blocking further design)
- [ ] Local dev environment: mostly done (see below), but backend/frontend `npm install` + run steps still need adding to SETUP.md once there's actual code to install.
- [ ] Cloudflare + DNS setup for ioriore.com not yet done (add site to Cloudflare, point nameservers, add Heroku custom domains, configure Bot Fight Mode + firewall rules).
- [ ] Telegram notification channel setup (for scheduled job failures + health checks).
- [ ] Postgres schema design for multi-strategy support.
- [ ] Exact screen list — draft below, pending further review.

## Decisions made
- Stack: Node.js backend, React frontend, PostgreSQL via Heroku Postgres Essential-1, Heroku hosting.
- **UI template: Tabler**, consistent with the existing menaris-admin-app (React + Bootstrap 5 + Tabler + ApexCharts) and the Tabler-specific UI/UX rules already in global CLAUDE.md. Consume via `@tabler/core` + `@tabler/icons-react` (official, actively maintained) — NOT the `tabler-react` community wrapper package (abandoned, no releases in 12+ months).
- **Charting: confirmed.** ApexCharts for general/aggregate charts (P&L over time, dashboard stats) + TradingView's lightweight-charts for OHLC/candlestick underlying price charts. Both free for this use case (ApexCharts Community License, org revenue < $2M/yr; lightweight-charts requires visible TradingView attribution on pages using it). Payoff diagrams (covered call/CSP risk-reward "hockey stick") will be custom-built as a computed line/area series in ApexCharts, not a built-in feature. Will build one shared reusable wrapper component per library (no official React bindings for lightweight-charts).
- Two users initially, same access level, no per-role permissions needed.
- **Local dev environment set up on Marcelo's Mac** (2026-08-11): nvm installed with Node 24 pinned per-project via `.nvmrc` (auto-switches on `cd`, doesn't touch the existing system Node 26 used by other projects like menaris-admin-api). Postgres.app installed running PostgreSQL 17 (matches Heroku Postgres's default), with `iorio_reloaded_development` and `iorio_reloaded_test` databases created. `.env` / `.env.example` added to iorio-reloaded-api. Heroku CLI already present. Full steps documented in `SETUP.md` in iorio-reloaded-api — written so the user's developer friend (who also uses Claude Code) can hand his Claude Code the file and replicate the setup.
- Personalization (e.g. table column visibility) stored client-side in localStorage only.
- Strategies implemented in code, not via UI; schema/platform must support multiple strategies running in parallel.
- **v1 strategy scope: covered calls + cash-secured puts**, both from day one.
- **Historical options data / deep backtesting: shelved for now.** 10 years of full-detail options data doesn't fit a 10GB Postgres budget, and most vendors' ToS block the "subscribe a month, bulk-export, cancel" approach. Revisit as a Phase 2+ idea once core platform is proven.
- **All market data (screening + pricing) sourced directly from IBKR — no separate third-party market-data vendor.** Real-time US stocks + OPRA options data requires IBKR's "US Securities Snapshot and Futures Value Bundle" (~$10/month, waived if ~$30/month in commissions generated — likely not waived given low trading frequency, so budget for ~$10/month).
- **Realized/unrealized P&L must be sourced live from IBKR directly** (source of truth), not computed from our own stored records + third-party marks.
- **IBKR connectivity architecture: dedicated VPS, not Heroku, not the user's Mac.**
  - Reasoning: Heroku dynos (all tiers, including Basic) are forcibly restarted roughly every 24h with an ephemeral filesystem wiped on each restart — this is a platform-level behavior, not an Eco-tier limitation. IB Gateway needs a stable, persistent process to avoid repeated 2FA challenges. Verified via web research: no examples found of anyone running Gateway/TWS directly on Heroku; the one real-world Heroku+IBKR project found (ozdemirozcelik/pairs-api-v3) explicitly separates the IBKR connection into a non-Heroku component.
  - Mac-hosted option was ruled out once live P&L (not just execution) needed IBKR connectivity — that requires near-continuous uptime during market hours, which a laptop can't reliably guarantee, unlike a VPS.
  - **Docker image: `gnzsnz/ib-gateway-docker`** (github.com/gnzsnz/ib-gateway-docker) — most established/maintained option (1.1k stars, 233 forks). Has `AUTO_RESTART_TIME` config that restarts Gateway daily without requiring 2FA re-validation.
  - **Node.js client library: `@stoqey/ib`** (npmjs.com/package/@stoqey/ib) — actively maintained TypeScript port of IBKR's official Java client, used by the Node backend to talk to Gateway over its socket API.
  - **VPS provider: Hetzner**, ~€8/month for 2 vCPU/4GB RAM (2GB minimum recommended; Gateway's default Java heap is ~768MB). EU-based; latency to IBKR's US servers is irrelevant for a low-frequency options strategy.
  - Division of labor: user creates the Hetzner account/billing (Claude cannot create billing accounts); Claude configures everything on the box once given SSH access.
- **Domain: ioriore.com** (already owned by user). Likely subdomain split: `app.ioriore.com` (frontend), `api.ioriore.com` (backend) — to confirm when we do the Cloudflare/DNS setup.
- **Heroku topology: two separate Heroku apps** (matches the existing `iorio-reloaded-api` / `iorio-reloaded-app` repo split), both on Eco dynos.
  - Eco hours are pooled per account: 1,000 hrs/month for $5/mo flat. One always-on dyno alone uses ~720 hrs/month; sleeping dynos consume ~0. Given daily-check-in usage, both apps sleeping between visits should fit comfortably in the pool.
  - **Both apps proxied through Cloudflare's free plan** (Bot Fight Mode + custom firewall rules) to stop scanner/bot traffic from waking sleeping dynos and burning hours. Requires a custom domain (Cloudflare can't proxy Heroku's default `*.herokuapp.com`).
  - Note: this protects against *bot-driven* wake-ups, not the user's own daily cold start — opening the app after a dyno's been asleep will still take several seconds to ~30s to respond. Not solved yet; revisit if it proves annoying in practice.

## Built
(nothing yet)

## Draft screen list (NOT final — pending further review)
General (cross-strategy):
1. Book Dashboard — aggregate P&L (daily/weekly/monthly/yearly), realized vs unrealized, across all strategies.
2. Positions — open positions, max gain/loss, price targets, close triggers.
3. Trade Approval Queue — system-suggested trades pending user confirmation/edit before sending to IBKR.
4. Trade Blotter / History — executed trades, realized P&L.
5. System Health / Job Status — scheduled job run history, errors, mirrors Telegram alerts.

Strategy-specific (covered calls / CSP):
6. Screener & Shortlist — candidate tickers ranked by suitability (liquidity, IV, etc.), add/remove from shortlist.
7. Opportunities — for shortlisted tickers, suggested strikes/expiries/sizes with trade details to validate.

## Optional / future ideas (not being built unless requested)
- Backtesting/simulation engine using historical options data.
- Full historical options data warehouse (10 years) — cost/ToS permitting.
- IBKR chart embedding for open positions (vs. building our own).
