# Backtesting — data files, jobs and history

Local-only (Marcelo's Mac). Decisions: `project_backtesting_design_decisions_2026_10_12` in memory, formulas in `FORMULAS.md`.

## Folder

`BACKTEST_DATA_DIR` in `.env` (relative paths resolve from the API repo root; the default checkout uses `backtest-data`, gitignored). Unset = the backtest routes are not mounted (staging, prod). Contents:

- `<SYMBOL>.sqlite` — one file per symbol: the option data, written only by the downloader, and IBKR's stock bars ("IBKR stock bars" below), written only by Node.
- `fred-DTB3.json` — the 3-month T-bill series cache (risk-free rate and interest on cash), written by the engine.
- `tables/<YEAR>.json` — walk-forward model tables built from history before 1 January of YEAR, written by the engine.

## Symbol file (`<SYMBOL>.sqlite`, schema version 3)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: symbol, schema_version ('3'), quote_time_et ('10:00:00'), max_dte ('all'), created_at (ISO UTC),
--       intraday_interval ('30m'), intraday_window ('10:00-15:30')

CREATE TABLE days (
  trading_date TEXT PRIMARY KEY,          -- YYYY-MM-DD (Eastern)
  status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
  quote_rows INTEGER NOT NULL,
  eod_rows INTEGER NOT NULL,
  open_interest_rows INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,               -- ISO UTC
  all_expiries INTEGER NOT NULL DEFAULT 0 -- 1 = its quotes, eod and open_interest rows hold every expiry; 0 = stored with the 45-day cap, to be completed
);

-- Every contract's last NBBO at or before 10:00:00 ET, every expiry from trading_date on (0..45 days in a day stored with the cap).
CREATE TABLE quotes (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  bid REAL, ask REAL, bid_size INTEGER, ask_size INTEGER,
  quoted_at TEXT,                         -- the NBBO's own timestamp, ISO with offset
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID;

-- That day's end-of-day per contract (ThetaData builds it ~17:15 ET), every expiry (0..46 days in a day stored with the cap).
CREATE TABLE eod (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  close REAL, volume INTEGER, bid REAL, ask REAL,   -- bid/ask = closing NBBO
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID;

-- Open interest as ThetaData reports it for trading_date (the previous session's closing OI, published ~06:30 ET),
-- i.e. what Pluto sees at 10:00. Every expiry (0..46 days in a day stored with the cap).
CREATE TABLE open_interest (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  open_interest INTEGER NOT NULL,
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID;

-- One row per day whose intraday quotes are stored; only days with days.status = 'complete' get one.
CREATE TABLE intraday_days (
  trading_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
  look_count INTEGER NOT NULL,            -- distinct look times stored (12 on a normal day)
  quote_rows INTEGER NOT NULL,
  strike_window_pct REAL,                 -- the --intraday-strike-window-pct applied to this day; NULL = every strike
  fetched_at TEXT NOT NULL,               -- ISO UTC
  all_expiries INTEGER NOT NULL DEFAULT 0 -- 1 = its intraday_quotes rows hold every expiry; 0 = stored with the 45-day cap, to be completed
);

-- Every contract's NBBO at each look: the last quote at or before the look time, the same values
-- option_at_time_quote gives for that time. Looks every 30 minutes from 10:00 to 15:30 ET, every expiry (0..45 days in a
-- day stored with the cap).
CREATE TABLE intraday_quotes (
  trading_date TEXT NOT NULL, look_time TEXT NOT NULL,   -- 'HH:MM' Eastern
  expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  bid REAL, ask REAL, bid_size INTEGER, ask_size INTEGER,
  quoted_at TEXT,                         -- always NULL: ThetaData stamps these rows with the look time, not the quote's own
  PRIMARY KEY (trading_date, look_time, expiry, strike, option_right)
) WITHOUT ROWID;

-- What a stored day lacks (see "Days ThetaData cannot serve"). Each row is asked for again on up to 3 later runs.
CREATE TABLE day_issues (
  trading_date TEXT NOT NULL,
  part TEXT NOT NULL CHECK (part IN ('quotes', 'eod', 'open_interest', 'intraday_quotes')),
  expiry TEXT,                            -- the expiration left out; NULL = the whole part
  message TEXT NOT NULL,                  -- ThetaData's error, or 'no data returned'
  recorded_at TEXT NOT NULL,              -- ISO UTC, of the last attempt
  attempts INTEGER NOT NULL DEFAULT 1     -- runs that tried: 1 when recorded, +1 per later run that still could not store it
);

-- Days with a part that could not be retrieved at all: the 10:00 quotes, the end of day or the open interest (no
-- `days` row), or the intraday quotes (no `intraday_days` row).
CREATE TABLE unavailable_days (
  trading_date TEXT PRIMARY KEY,
  reason TEXT NOT NULL,                   -- starts with 'quotes at 10:00: ', 'end of day: ', 'open interest: ' or 'intraday quotes: '
  attempts INTEGER NOT NULL,              -- runs that tried
  last_attempt_at TEXT NOT NULL           -- ISO UTC
);
```

`schema_version` `'3'` is a file with every table and column above. `intraday_days`, `intraday_quotes`, `day_issues` and `unavailable_days` were added after the first downloads, `day_issues.attempts` after those (version `'2'`), and the `all_expiries` flags when the downloader began keeping every expiry (version `'3'`). Before that it kept expiries 0..45 days after the trading date for the 10:00 and intraday quotes, 0..46 for the end of day and the open interest (`max_dte` `'45'`). When it opens an older file, the downloader creates what the file lacks (and the two intraday meta keys), adds the flags at 0 (1 for `no_data` days, which have nothing to complete), and sets `max_dte` to `'all'` and `schema_version` to `'3'`. Readers accept the three versions.

The engine reads expiries 0..45 days out (0..46 for the end of day and the open interest) whatever the file holds, and of the `day_issues` only those about a whole part or an expiration in that window, so a file completed to every expiry replays every session as before. Longer-dated contracts are read once a strategy uses them.

Rules:

- A day's rows and its `days` row are written in one transaction: a day is fully present or absent. The same holds for its intraday quotes and `intraday_days` row. Both parts of a day fetched in one run share one transaction.
- A day is done when it has a `days` row and, unless that row says `no_data`, an `intraday_days` row, both with `all_expiries = 1`. Resuming works through every weekday from the requested start to the last finished session that is not done, and fetches only what the day lacks: a file downloaded before intraday quotes existed gets only those, without its 10:00 parts being fetched again.
- A part stored with the 45-day cap (`all_expiries = 0`) is completed: fetched again for every expiry, and only the rows the day lacks are added (a stored row is left as it is). Its row counts and flag are updated in the same transaction. A completion that cannot retrieve one of the three 10:00 parts at all completes none of them, and one that cannot retrieve the intraday quotes leaves them as they are; either way the day gets no `unavailable_days` row and is completed on a later run. Issues the completion settles are deleted; what it leaves out gets a `day_issues` row.
- A weekday with no data at all (exchange holiday) is stored as `status = 'no_data'` with zero counts, so it is not fetched again.
- The last finished session: today counts only after 18:00 ET (EOD is built ~17:15 ET); otherwise the last weekday before today.
- Prices are dollars; strikes are dollars (ThetaData's tenth-of-a-cent strikes converted).
- On a 13:00 early-close day ThetaData still returns every look: the looks after the close repeat the closing quotes. The downloader stores them as returned; the engine decides from the market calendar which looks count.
- `--intraday-strike-window-pct N` keeps intraday quotes only for strikes within N% of the day's at-the-money strike: the strike whose call and put mids at 10:00 are closest, in the nearest expiry at least 1 day out. Without the flag every strike is kept. The 10:00 quotes, end of day and open interest are never narrowed.

### Days ThetaData cannot serve

A fault in ThetaData's data for one day (for example `INTERNAL: Corrupt FIT data`) never stops a download:

1. Each part of a day (`quotes`, `eod`, `open_interest`, `intraday_quotes`) is one request for all expirations. When it still fails after its retries, or answers with rows that cannot be used (an unreadable expiration or strike), the downloader first asks again for data it has already stored (the latest stored day, one expiration, the same kind of request; while the file holds no such day yet, the symbol's list of expirations). If that fails too, ThetaData is having a problem: the run ends with an error and nothing is recorded for the day.
2. Otherwise the fault belongs to the day: the part is asked for one expiration at a time (every expiration the symbol lists from the trading date to 1,100 days after it; completing a part stored with the cap, only those beyond 45 days, 46 for `eod` and `open_interest`, and none listed there leaves nothing to add). What comes back is stored; each expiration that still fails gets a `day_issues` row, and the day is stored as `complete` with what was retrieved.
3. If a part cannot be retrieved at all (the request for all expirations failed and so did every expiration asked for on its own), the day is recorded in `unavailable_days` with the part named. For the 10:00 quotes, the end of day or the open interest nothing is stored for the day (no `days` row). For the intraday quotes of a day whose 10:00 parts are stored, the day keeps its `days` row and gets no `intraday_days` row. Either way the run continues with the next day.
4. Every later run asks once more for each unavailable day in its range (`attempts` counts the runs); when the day is finally stored its `unavailable_days` row is deleted.
5. A part ThetaData answers with no data, on a day that has data in another part, is stored empty and gets a `day_issues` row (`expiry` NULL, message `no data returned`): for example an end-of-day report that was not built yet. A weekday with no data in any part is a `no_data` day and has no issue.
6. Every `day_issues` row of a stored day is asked for again on up to 3 later runs (`attempts` 1 to 4), before the run fetches new days: one request for that expiration, or for the whole part when `expiry` is NULL. Rows that come back are stored, the day's row counts are updated and the issue is deleted (intraday quotes keep the strike window the day was stored with). One expiration that now answers with no data has nothing left to ask for: its issue is deleted. A request that fails again adds an attempt, but only after the check of point 1 shows ThetaData still answers; otherwise the run ends with an error and no attempt is counted. After the third later run the row stays as the record of what the day lacks.
7. While the file holds no rows of a part yet, the check of point 1 can only ask for the symbol's expirations, which says little about that part. So a part that cannot be retrieved at all on 3 days in a row, with none of it stored yet, ends the run with an error (those days stay in `unavailable_days` and are asked for again on the next run). Once the file holds the part, each such day is checked against the stored data instead, however many follow.

A permission or authentication refusal is not a day's fault: it ends the run at once.

### IBKR stock bars

Every stock price the engine uses comes from IBKR's bars kept in the file, never from the option quotes (the quotes only tell where splits fall, `engine/splitFactors.ts`). Node writes them (`src/backtest/refreshFileStockBars.ts`); the downloader never touches these tables.

```sql
-- IBKR daily TRADES bars for the last 20 years, with the daily OPTION_IMPLIED_VOLATILITY (NULL where IBKR has none).
CREATE TABLE ibkr_daily_bars (
  trading_date TEXT PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, volume REAL, implied_volatility REAL
) WITHOUT ROWID;

-- IBKR 30-minute TRADES bars (regular hours) from 1 January of the year of the file's first option day.
CREATE TABLE ibkr_intraday_bars (
  trading_date TEXT NOT NULL,             -- YYYY-MM-DD (Eastern)
  start_minutes_et INTEGER NOT NULL,      -- the bar's start, minutes after midnight ET (570 = 09:30)
  bar_start TEXT NOT NULL,                -- ISO UTC
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (trading_date, start_minutes_et)
) WITHOUT ROWID;
-- meta keys: ibkr_bars_version ('1'), ibkr_bars_fetched_at (ISO UTC)
```

- Requests, one at a time through the Gateway the local API uses, 10 s apart: daily bars `20 Y`, implied volatility `20 Y`, then 30-minute bars `1 Y` per calendar year, each ending 06:00 UTC on 1 January of the next year (the running year: now). Bars after the last finished session are not stored. IBKR returns what it holds for the stock's current listing, up to the 20 years asked for: INTC from 2006-10, MU from 2009-12, TLT only from 2016-02 (checked 2026-10-14).
- Each refresh replaces every bar in one transaction: IBKR adjusts its whole history for splits as of the fetch, so a file never holds two adjustments. With no daily or no 30-minute bars returned nothing is written; a failed implied-volatility request is logged and the bars are written without it.
- Written when a download job's downloader worked through its range (so **Update** on a row of Data files refreshes them), and by `npm run backtest:backfill-file-stock-bars [-- SYMBOL ...]` for files downloaded before they existed (it skips a symbol whose download is running; a queued download refreshes them again when it ends).
- The stock's price at a look is the close of the last 30-minute bar ending by then (10:00 reads the 09:30 bar), × the day's split factor to put it on the traded scale. A day's close is its daily bar's, else its last 30-minute bar's. A session stops when either set ends before its last day.

## Downloader process protocol

`scripts/backtest/download_thetadata_symbol.py --symbol AAOI --start 2020-01-01 --end 2026-10-09 --data-dir /abs/path [--intraday-strike-window-pct 40]`, run with `.venv-backtest/bin/python`. Reads `THETADATA_API_KEY` from the API repo's `.env`. At most 2 requests in flight (the plan's limit). Prints one JSON object per line on stdout, nothing else on stdout (logs go to stderr):

- `{"type":"start","symbol":"AAOI","daysTotal":1700,"daysDone":1200}` — weekdays in range, and how many of them are done (see Rules)
- `{"type":"progress","daysDone":1201,"daysTotal":1700,"lastDate":"2024-03-15","quoteRows":1100}` — one per day that became done; `quoteRows` is the day's 10:00 quote rows. An unavailable day prints nothing.
- `{"type":"done","daysDone":1698,"daysTotal":1700,"unavailableDays":2,"daysWithIssues":3}` then exit 0 — the whole range was worked through. `unavailableDays` = `unavailable_days` rows in the range (so `daysDone` stays below `daysTotal` by that many), `daysWithIssues` = days in the range with `day_issues` rows (pieces still being asked for again, and those left after their 3 later runs).
- `{"type":"error","message":"..."}` then a non-zero exit

SIGTERM stops after the day in progress is either committed or discarded (never half-written).

**One ThetaData login per API key at a time.** A second login with the same key (a probe script, a second downloader, the Theta Terminal) invalidates the session of the one already running: within a few minutes its requests fail with `UNAUTHENTICATED: Invalid session ID`. The job queue runs one download at a time for this reason as well; nothing else may log in while a download runs. When a download does lose its session it waits (10 s, then 20, 40, 80, 160), logs in again and repeats the request; after 5 new logins in one run it ends with the error "another ThetaData login keeps taking the session … only one program may use the API key at a time". Any other authentication or permission error ends the run at once.

## Jobs (`backtest_jobs`)

The API creates the row and spawns `scripts/run-backtest-job.ts <jobId>` detached (`spawn(..., { detached: true, stdio: 'ignore' }).unref()`, logs to `BACKTEST_DATA_DIR/logs/<jobId>.log`), so an API restart never stops a job. The job process:

- sets `running`, `pid`, `started_at`; writes `progress_done/total/label` and `heartbeat_at` at least every 10 s;
- checks `cancel_requested` at least every 10 s and stops cleanly (status `cancelled`);
- ends `succeeded` or `failed` (`error`), `finished_at`.

A `running` job whose heartbeat is older than 60 s is shown as **stopped** (derived, not stored); Resume re-spawns the same job id. Downloads run one at a time (ThetaData allows 2 requests in flight and one download uses both): a new download is `queued` while another runs, and the next queued one starts when a download finishes, is cancelled, or is found stopped when the screen loads. Backtest runs can run alongside each other.

A download job runs, in order: the IBKR daily-bar top-up for the symbol (back to 2016-01-01, local DB), the ThetaData downloader, then, when the downloader worked through its range, the file's IBKR stock bars and its split schedule. A failed IBKR step fails the job (`Option data downloaded. The IBKR stock bars for the file failed (…). Resume retries.`). A download whose range was worked through ends `succeeded` even when some days could not be stored in full; its final label says so, e.g. `saved up to 2026-10-09 · 2 days unavailable · 1 day with gaps` (`nothing new to save` when the run stored no new day).

## History in the local DB

One-off, before walk-forward tables can be built: `npm run backtest:backfill-history` fetches IBKR daily bars (TRADES) and daily implied volatility (OPTION_IMPLIED_VOLATILITY) back to 2016-01-01 for every ticker in the local DB, through the IBKR Gateway the local API uses, and stores them in `daily_price_bars` (local DB only).
