# Backtesting — data files, jobs and history

Local-only (Marcelo's Mac). Decisions: `project_backtesting_design_decisions_2026_10_12` in memory, formulas in `FORMULAS.md`.

## Folder

`BACKTEST_DATA_DIR` in `.env` (relative paths resolve from the API repo root; the default checkout uses `backtest-data`, gitignored). Unset = the backtest routes are not mounted (staging, prod). Contents:

- `<SYMBOL>.sqlite` — one file per symbol, written only by the downloader.
- `fred-DTB3.json` — the 3-month T-bill series cache (risk-free rate and interest on cash), written by the engine.
- `tables/<YEAR>.json` — walk-forward model tables built from history before 1 January of YEAR, written by the engine.

## Symbol file (`<SYMBOL>.sqlite`, schema version 1)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: symbol, schema_version ('1'), quote_time_et ('10:00:00'), max_dte ('45'), created_at (ISO UTC)

CREATE TABLE days (
  trading_date TEXT PRIMARY KEY,          -- YYYY-MM-DD (Eastern)
  status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
  quote_rows INTEGER NOT NULL,
  eod_rows INTEGER NOT NULL,
  open_interest_rows INTEGER NOT NULL,
  fetched_at TEXT NOT NULL                -- ISO UTC
);

-- Every contract's last NBBO at or before 10:00:00 ET, expiries 0..45 days after trading_date.
CREATE TABLE quotes (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  bid REAL, ask REAL, bid_size INTEGER, ask_size INTEGER,
  quoted_at TEXT,                         -- the NBBO's own timestamp, ISO with offset
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID;

-- That day's end-of-day per contract (ThetaData builds it ~17:15 ET), expiries 0..46 days.
CREATE TABLE eod (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  close REAL, volume INTEGER, bid REAL, ask REAL,   -- bid/ask = closing NBBO
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID;

-- Open interest as ThetaData reports it for trading_date (the previous session's closing OI, published ~06:30 ET),
-- i.e. what Pluto sees at 10:00. Expiries 0..46 days.
CREATE TABLE open_interest (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  open_interest INTEGER NOT NULL,
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID;
```

Rules:

- A day's rows and its `days` row are written in one transaction: a day is fully present or absent. Resuming fetches every weekday from the requested start to the last finished session that has no `days` row.
- A weekday with no data at all (exchange holiday) is stored as `status = 'no_data'` with zero counts, so it is not fetched again.
- The last finished session: today counts only after 18:00 ET (EOD is built ~17:15 ET); otherwise the last weekday before today.
- Prices are dollars; strikes are dollars (ThetaData's tenth-of-a-cent strikes converted).

## Downloader process protocol

`scripts/backtest/download_thetadata_symbol.py --symbol AAOI --start 2020-01-01 --end 2026-10-09 --data-dir /abs/path`, run with `.venv-backtest/bin/python`. Reads `THETADATA_API_KEY` from the API repo's `.env`. At most 2 requests in flight (the plan's limit). Prints one JSON object per line on stdout, nothing else on stdout (logs go to stderr):

- `{"type":"start","symbol":"AAOI","daysTotal":1700,"daysDone":1200}` — days in range, days already in the file
- `{"type":"progress","daysDone":1201,"daysTotal":1700,"lastDate":"2024-03-15","quoteRows":1100}`
- `{"type":"done","daysDone":1700,"daysTotal":1700}` then exit 0
- `{"type":"error","message":"..."}` then a non-zero exit

SIGTERM stops after the day in progress is either committed or discarded (never half-written).

## Jobs (`backtest_jobs`)

The API creates the row and spawns `scripts/run-backtest-job.ts <jobId>` detached (`spawn(..., { detached: true, stdio: 'ignore' }).unref()`, logs to `BACKTEST_DATA_DIR/logs/<jobId>.log`), so an API restart never stops a job. The job process:

- sets `running`, `pid`, `started_at`; writes `progress_done/total/label` and `heartbeat_at` at least every 10 s;
- checks `cancel_requested` at least every 10 s and stops cleanly (status `cancelled`);
- ends `succeeded` or `failed` (`error`), `finished_at`.

A `running` job whose heartbeat is older than 60 s is shown as **stopped** (derived, not stored); Resume re-spawns the same job id. Downloads run one at a time (ThetaData allows 2 requests in flight and one download uses both): a new download is `queued` while another runs, and the next queued one starts when a download finishes, is cancelled, or is found stopped when the screen loads. Backtest runs can run alongside each other.

A download job runs, in order: the IBKR daily-bar top-up for the symbol (back to 2016-01-01, local DB), then the ThetaData downloader.

## History in the local DB

One-off, before walk-forward tables can be built: `npm run backtest:backfill-history` fetches IBKR daily bars (TRADES) and daily implied volatility (OPTION_IMPLIED_VOLATILITY) back to 2016-01-01 for every ticker in the local DB, through the IBKR Gateway the local API uses, and stores them in `daily_price_bars` (local DB only).
