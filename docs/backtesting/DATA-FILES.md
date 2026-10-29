# Backtesting — data files, jobs and history

Local-only (Marcelo's Mac). Decisions: `project_backtesting_design_decisions_2026_10_12` in memory, formulas in `FORMULAS.md`.

## Folder

`BACKTEST_DATA_DIR` in `.env` (relative paths resolve from the API repo root; the default checkout uses `backtest-data`, gitignored). Unset = the backtest routes are not mounted (staging, prod). Contents:

- `<SYMBOL>.sqlite` — one file per symbol: the option data, written only by the downloader, and IBKR's stock bars ("IBKR stock bars" below), written only by Node.
- `fred-DTB3.json` — the 3-month T-bill series cache (risk-free rate and interest on cash), written by the engine.
- `tables/<YEAR>.json` — walk-forward model tables built from history before 1 January of YEAR, written by the engine.

## Symbol file (`<SYMBOL>.sqlite`, schema version 4)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: symbol, schema_version ('4'), quote_time_et ('10:00:00'), max_dte ('all'), created_at (ISO UTC),
--       intraday_interval ('30m'), intraday_window ('10:00-15:30')

CREATE TABLE days (
  trading_date TEXT PRIMARY KEY,          -- YYYY-MM-DD (Eastern)
  status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
  quote_rows INTEGER NOT NULL,
  eod_rows INTEGER NOT NULL,
  open_interest_rows INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,               -- ISO UTC
  all_expiries INTEGER NOT NULL DEFAULT 0 -- 1 = its 10:00 quotes, end of day and open interest hold every expiry; 0 = stored with the 45-day cap, to be completed
);

-- The option data is stored as slices: one row per day, look and expiry holding that expiry's contracts (see "Slices").
-- key = day × 2^32 + look minute × 2^16 + days to expiry: the day as days since 1970-01-01, the look as minutes after
-- midnight ET (600 = 10:00; 0 in the end-of-day and open-interest tables). One integer key, so a day's look up to an
-- expiry window is one range read.

-- Every contract's last NBBO at or before 10:00:00 ET, every expiry from trading_date on (0..45 days in a day stored with the cap).
CREATE TABLE ten_oclock_quote_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL,
  has_ask_above_zero INTEGER NOT NULL, data BLOB NOT NULL);

-- Every contract's NBBO at each look: the last quote at or before the look time, the same values
-- option_at_time_quote gives for that time. Looks every 30 minutes from 10:00 to 15:30 ET, the 10:00 look included (on
-- a few days it differs from the 10:00 quotes), every expiry (0..45 days in a day stored with the cap).
CREATE TABLE intraday_quote_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL,
  data BLOB NOT NULL);

-- That day's end of day per contract (ThetaData builds it ~17:15 ET), every expiry (0..46 days in a day stored with the cap).
CREATE TABLE end_of_day_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL,
  has_volume INTEGER NOT NULL, data BLOB NOT NULL);

-- Open interest as ThetaData reports it for trading_date (the previous session's closing OI, published ~06:30 ET),
-- i.e. what Pluto sees at 10:00. Every expiry (0..46 days in a day stored with the cap).
CREATE TABLE open_interest_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL,
  data BLOB NOT NULL);

-- One row per day whose intraday quotes are stored; only days with days.status = 'complete' get one.
CREATE TABLE intraday_days (
  trading_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
  look_count INTEGER NOT NULL,            -- distinct look times stored (12 on a normal day)
  quote_rows INTEGER NOT NULL,
  strike_window_pct REAL,                 -- the --intraday-strike-window-pct applied to this day; NULL = every strike
  fetched_at TEXT NOT NULL,               -- ISO UTC
  all_expiries INTEGER NOT NULL DEFAULT 0 -- 1 = its intraday quotes hold every expiry; 0 = stored with the 45-day cap, to be completed
);

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

The engine reads expiries 0..45 days out (0..46 for the end of day and the open interest) whatever the file holds, and of the `day_issues` only those about a whole part or an expiration in that window, so a file completed to every expiry replays every session as before. Longer-dated contracts are read once a strategy uses them.

Slices:

- `data` holds the slice's contracts in strike order (the Call before the Put) as columns, each in the narrowest width its values need within the slice; the byte layout is in `src/backtest/engine/symbolFileSlices.ts`. Columns: 10:00 quotes: strike, right, bid, ask, bid size, ask size, quote time; intraday quotes: the same without the quote time; end of day: strike, right, close, volume, closing bid, closing ask; open interest: strike, right, open interest.
- Units: strikes in thousandths of a dollar, prices in cents, sizes, volumes and open interest as counts. A slice holding a value not exact in its unit keeps that column as the stored numbers (none did when the files were converted).
- The quote time is the 10:00 NBBO's own timestamp, kept as the milliseconds from it to 10:00:00 ET on the trading day; its ISO text (milliseconds, Eastern offset) is rebuilt exactly from it (`quoted_at_text_of` in `scripts/backtest/symbol_file_slices.py`). Intraday quotes have none: ThetaData stamps them with the look time.
- `call_count`/`put_count` and the flags answer Vol Farmer v2's checks (the next Call expiry, the counts within 45 days, any ask above 0, any volume the day before) without opening a slice.
- The downloader writes them with `scripts/backtest/symbol_file_slices.py`, the same bytes as `symbolFileSlices.ts` (`test_symbol_file_slices.py` holds bytes the engine wrote). A part written again replaces the day's slices of that part; a retried piece is merged into its slices (a contract stored already takes the new values); completing a day keeps the contracts it holds. A new file gets 16 KB pages.

Versions. The first downloads had no `intraday_days`, intraday quotes, `day_issues` or `unavailable_days`; `day_issues.attempts` came with version `'2'`, and the `all_expiries` flags with version `'3'`, when the downloader began keeping every expiry (before, it kept expiries 0..45 days after the trading date for the 10:00 and intraday quotes, 0..46 for the end of day and the open interest: `max_dte` `'45'`). Versions 1 to 3 stored the option data one row per contract (tables `quotes`, `intraday_quotes`, `eod`, `open_interest`). Version `'4'` (Marcelo 2026-10-29) holds the same data as slices in about a sixth of the space, read with about a tenth of the CPU. Every file was converted on 2026-10-29, each copy checked against its original row for row and value for value, and by a replay of the engine's reads, before replacing it. The engine and the downloader read and write version 4 only and refuse any other file; the conversion (`src/backtest/symbolFileSchemaFourConversion.ts`) is in the git history.

Rules:

- A day's rows and its `days` row are written in one transaction: a day is fully present or absent. The same holds for its intraday quotes and `intraday_days` row. Both parts of a day fetched in one run share one transaction.
- A day is done when it has a `days` row and, unless that row says `no_data`, an `intraday_days` row, both with `all_expiries = 1`. Resuming works through every weekday from the requested start to the last finished session that is not done, and fetches only what the day lacks: a file downloaded before intraday quotes existed gets only those, without its 10:00 parts being fetched again.
- A part stored with the 45-day cap (`all_expiries = 0`) is completed: fetched again for every expiry, and only the rows the day lacks are added (a stored row is left as it is). Its row counts and flag are updated in the same transaction. A completion that cannot retrieve one of the three 10:00 parts at all completes none of them, and one that cannot retrieve the intraday quotes leaves them as they are; either way the day gets no `unavailable_days` row and is completed on a later run. Issues the completion settles are deleted; what it leaves out gets a `day_issues` row.
- A weekday with no data at all (exchange holiday) is stored as `status = 'no_data'` with zero counts, so it is not fetched again. ThetaData publishes a session's data some hours after it ends and answers no data for it until then, so a weekday under 7 days old with no data in any part is recorded in `unavailable_days` instead (no `days` row) and asked for again on each run; once it is 7 days old, no data makes it a `no_data` day.
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
5. A part ThetaData answers with no data, on a day that has data in another part, is stored empty and gets a `day_issues` row (`expiry` NULL, message `no data returned`): for example an end-of-day report that was not built yet. A weekday with no data in any part is a `no_data` day (once 7 days old; see above) and has no issue.
6. Every `day_issues` row of a stored day is asked for again on up to 3 later runs (`attempts` 1 to 4), before the run fetches new days: one request for that expiration, or for the whole part when `expiry` is NULL. Rows that come back are stored, the day's row counts are updated and the issue is deleted (intraday quotes keep the strike window the day was stored with). One expiration that now answers with no data has nothing left to ask for: its issue is deleted. A request that fails again adds an attempt, but only after the check of point 1 shows ThetaData still answers; otherwise the run ends with an error and no attempt is counted. After the third later run the row stays as the record of what the day lacks.
7. While the file holds no rows of a part yet, the check of point 1 can only ask for the symbol's expirations, which says little about that part. So a part that cannot be retrieved at all on 3 days in a row, with none of it stored yet, ends the run with an error (those days stay in `unavailable_days` and are asked for again on the next run). Once the file holds the part, each such day is checked against the stored data instead, however many follow.

A permission or authentication refusal is not a day's fault: it ends the run at once.

### IBKR stock bars

Every stock price the engine uses comes from IBKR's bars kept in the file, never from the option quotes (the quotes only tell where splits fall, `engine/splitFactors.ts`). Node writes them (`src/backtest/refreshFileStockBars.ts`); the downloader never touches these tables.

```sql
-- IBKR daily TRADES bars from 2000-01-01 (or as far back as IBKR holds the listing), with the daily OPTION_IMPLIED_VOLATILITY (NULL where IBKR has none).
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

- Requests, one at a time through the Gateway the local API uses, 10 s apart. A refresh first tries the **last month**: daily bars, implied volatility and 30-minute bars, `1 M` each (3 requests). It does so only when the file's bars are version `1`, its 30-minute bars start no later than the year of its first option day, and both sets end at most 14 days before the last finished session.
- The last month is written over the stored bars of the same days, keeping the rest, when it shares at least one daily and one 30-minute bar with them and every shared close is the same once rounded to the cent. A stored day's implied volatility stays when IBKR sends none for it.
- Otherwise every bar is fetched again (the log says why): daily bars and implied volatility in whole years reaching 2000-01-01 (`27 Y` in 2026), then 30-minute bars `1 Y` per calendar year, each ending 06:00 UTC on 1 January of the next year (the running year: now). They replace every bar in one transaction: IBKR adjusts its whole history for splits as of the fetch, so a split since the last fetch changes every shared close and brings this full fetch, and a file never holds two adjustments.
- Bars after the last finished session or before 2000-01-01 are not stored. IBKR returns what it holds for the stock's current listing: with 20-year requests (2026-10-14) INTC from 2006-10, MU from 2009-12, TLT only from 2016-02; with `27 Y` (2026-10-29) SPY from 1999-11-05 but its implied volatility only from 2006-01-06. With no daily or no 30-minute bars returned nothing is written; a failed implied-volatility request is logged and the bars are written without it.
- Files fetched while the window was 20 years start in 2006 at the earliest. With `extendDailyBarsBack` (`--extend-daily-bars-back` below) a refresh asks instead for the daily bars and implied volatility reaching 2000-01-01 (2 requests) and, when every close the file has is the same to the cent in IBKR's answer (the same split adjustment), adds the days before the file's first one; every stored bar stays. Otherwise every bar is fetched again, reusing the daily bars just fetched. A failed implied-volatility request writes nothing.
- Written when a download job's downloader worked through its range (so **Update** on a row of Data files refreshes them), and by `npm run backtest:backfill-file-stock-bars [-- [--extend-daily-bars-back] SYMBOL ...]` for files downloaded before they existed (it skips a symbol whose download is running, a queued download refreshes them again when it ends, and a timeout or a pacing answer stops the run).
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

A `running` job whose heartbeat is older than 60 s is shown as **stopped** (derived, not stored); Resume re-spawns the same job id. Downloads run one at a time (ThetaData allows 2 requests in flight and one download uses both): a new download is `queued` while another runs, and the next queued one starts when a download finishes, is cancelled, or is found stopped when the screen loads. Backtests queue too (2026-10-17): at most `BACKTEST_MAX_PARALLEL_SESSIONS` (required, 6 locally) run at once and the rest wait `queued`, oldest first. The next one starts when a backtest ends, on a resume (a resumed backtest rejoins the end of the queue), when a session or a batch is created, when the overview or a batch page is read, and when the API starts, so queued runs survive a restart. A stopped backtest does not hold a place.

A download job runs, in order: the IBKR daily-bar top-up for the symbol (back to 2016-01-01, local DB), the ThetaData downloader, then, when the downloader worked through its range, the file's IBKR stock bars and its split schedule. A failed IBKR step fails the job (`Option data downloaded. The IBKR stock bars for the file failed (…). Resume retries.`). When the top-up finds that IBKR has no stock contract for the symbol (error 200 "No security definition", from the contract lookup or the historical request: a delisted or misspelt symbol), the job fails at once, before the downloader starts: the backtests take their stock prices from IBKR only. A Gateway outage or timeout does not stop it. A download whose range was worked through ends `succeeded` even when some days could not be stored in full; its final label says so, e.g. `saved up to 2026-10-09 · 2 days unavailable · 1 day with gaps` (`nothing new to save` when the run stored no new day).

## History in the local DB

One-off, before walk-forward tables can be built: `npm run backtest:backfill-history` fetches IBKR daily bars (TRADES) and daily implied volatility (OPTION_IMPLIED_VOLATILITY) back to 2016-01-01 for every ticker in the local DB, through the IBKR Gateway the local API uses, and stores them in `daily_price_bars` (local DB only).

Deleting a data file (Data files → Delete, `DELETE /backtest/data-files/:symbol`) removes `<SYMBOL>.sqlite` with its `-wal`/`-shm`/`-journal` side files, `splits/<SYMBOL>.json` and the symbol's finished download jobs. It is refused while a download, an analysis or a backtest session using the symbol is queued or running (a stopped download counts: cancel it first). Past sessions, analyses, the `tickers` row and its IBKR daily bars stay.
