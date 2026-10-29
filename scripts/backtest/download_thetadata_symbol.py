# Downloads one symbol's option history from ThetaData into <data-dir>/<SYMBOL>.sqlite for the model backtest. For each
# weekday, for every expiry: every contract's NBBO at 10:00 ET, that day's end-of-day report, the open interest reported
# that morning, and the NBBO at every 30-minute look from 10:00 to 15:30 ET, stored as schema 4's slices
# (symbol_file_slices.py). A day flagged as stored with the earlier 45-day cap (days.all_expiries or
# intraday_days.all_expiries 0) is completed by fetching its parts again and adding only the rows it lacks.
# Resumable: what a day already has in the file is not fetched again. A day ThetaData cannot serve never stops the run:
# what can be retrieved is kept, what cannot is recorded (day_issues, unavailable_days) and asked for again on later
# runs. At most 2 requests in flight (the plan's limit). Progress goes to stdout as JSON lines, logs to stderr. Spec: docs/backtesting/DATA-FILES.md.
#
# Run with the backtest venv: .venv-backtest/bin/python scripts/backtest/download_thetadata_symbol.py \
#   --symbol AAOI --start 2020-01-01 --end 2026-10-09 --data-dir /abs/path [--intraday-strike-window-pct 40]

import argparse
import collections
import concurrent.futures
import dataclasses
import datetime
import functools
import json
import logging
import math
import os
import re
import signal
import sqlite3
import sys
import threading
import time
from pathlib import Path
from zoneinfo import ZoneInfo

import grpc
import httpx
from dotenv import dotenv_values
from thetadata import ThetaClient
from thetadata.errors import AuthenticationError, NoDataFoundError

import symbol_file_slices as slices

SCHEMA_VERSION = "4"
# A new file's page size: the slices of schema 4 fit 16 KB pages best (docs/backtesting/DATA-FILES.md).
NEW_FILE_PAGE_SIZE = 16384
QUOTE_TIME_EASTERN = "10:00:00"
# Every expiry is stored. A day stored with the earlier caps below is flagged all_expiries 0 and completed to every
# expiry as it is planned.
MAX_DTE_META = "all"
EARLIER_QUOTE_MAX_DAYS_TO_EXPIRY = 45
EARLIER_END_OF_DAY_AND_OPEN_INTEREST_MAX_DAYS_TO_EXPIRY = 46
# An expiration asked for on its own (when a request for all of them keeps failing) lies at most this many days out:
# long-dated options (LEAPS) are listed up to about three years ahead.
EXPIRATION_BY_EXPIRATION_MAX_DAYS_TO_EXPIRY = 1_100
INTRADAY_INTERVAL = "30m"
INTRADAY_FIRST_LOOK_EASTERN = "10:00:00"
INTRADAY_LAST_LOOK_EASTERN = "15:30:00"
INTRADAY_WINDOW = "10:00-15:30"
INTRADAY_LOOK_TIMES = tuple(f"{minutes // 60:02d}:{minutes % 60:02d}" for minutes in range(10 * 60, 15 * 60 + 30 + 1, 30))
ALL_EXPIRATIONS = "*"
MAX_REQUESTS_IN_FLIGHT = 2
DAYS_FETCHED_AHEAD = 2
SESSION_FINISHED_HOUR_EASTERN = 18
# ThetaData publishes a session's data some hours after it ends and, until then, answers no data for it, as for a
# holiday. So a weekday with no data in any part is final (a 'no_data' day) only once it is this many days old; until
# then it is recorded as unavailable and asked for again on each run.
NO_DATA_IS_FINAL_AFTER_CALENDAR_DAYS = 7
NOT_PUBLISHED_YET_REASON = f"no data in any part yet: ThetaData may not have published this day; asked for again until it is {NO_DATA_IS_FINAL_AFTER_CALENDAR_DAYS} days old"
EASTERN_TIME_ZONE = ZoneInfo("America/New_York")
API_REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
API_ENV_FILE_PATH = API_REPOSITORY_ROOT / ".env"
RETRY_DELAYS_SECONDS = (2, 5, 15, 30, 60)
EXPIRATION_BY_EXPIRATION_RETRY_DELAYS_SECONDS = (2, 5)
# A piece listed in day_issues is asked for again on this many later runs.
RETRY_RUNS_PER_DAY_ISSUE = 3
# While the file holds no rows of a part to check the service with, the run stops once that part could not be
# retrieved at all this many days in a row.
WHOLE_PART_FAILURES_IN_A_ROW_THAT_STOP_THE_RUN = 3
NO_DATA_RETURNED_MESSAGE = "no data returned"
# Waits before each new login after another login took the session; their number is the most new logins per run.
WAITS_BEFORE_LOGIN_AFTER_SESSION_LOSS_SECONDS = (10, 20, 40, 80, 160)
REQUEST_DEADLINE_SECONDS = 600
SQLITE_BUSY_TIMEOUT_MILLISECONDS = 30_000
STOP_CHECK_INTERVAL_SECONDS = 0.5
STRIKE_DECIMALS = 3
PRICE_DECIMALS = 6

TRANSIENT_GRPC_STATUS_NAMES = {"UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "INTERNAL", "ABORTED", "UNKNOWN", "CANCELLED"}
REFUSED_GRPC_STATUS_NAMES = {"PERMISSION_DENIED", "UNAUTHENTICATED"}
SESSION_LOST_GRPC_STATUS_NAME = "UNAUTHENTICATED"
SESSION_LOST_DETAILS_MARKER = "invalid session"

SCHEMA_STATEMENTS = (
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS days (
  trading_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
  quote_rows INTEGER NOT NULL,
  eod_rows INTEGER NOT NULL,
  open_interest_rows INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  all_expiries INTEGER NOT NULL DEFAULT 0
)""",
    """CREATE TABLE IF NOT EXISTS intraday_days (
  trading_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
  look_count INTEGER NOT NULL,
  quote_rows INTEGER NOT NULL,
  strike_window_pct REAL,
  fetched_at TEXT NOT NULL,
  all_expiries INTEGER NOT NULL DEFAULT 0
)""",
    """CREATE TABLE IF NOT EXISTS day_issues (
  trading_date TEXT NOT NULL,
  part TEXT NOT NULL CHECK (part IN ('quotes', 'eod', 'open_interest', 'intraday_quotes')),
  expiry TEXT,
  message TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
)""",
    """CREATE TABLE IF NOT EXISTS unavailable_days (
  trading_date TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_attempt_at TEXT NOT NULL
)""",
) + slices.SLICE_TABLES_SQL

logger = logging.getLogger("download_thetadata_symbol")


class DownloadFailed(Exception):
    """A failure that ends the run; its text is the error line's message."""


class RequestRefused(DownloadFailed):
    """ThetaData refused the request (permission or authentication): the run stops at once."""


class RequestFailed(DownloadFailed):
    """A request that kept failing, or whose answer could not be used. For one part of one day this is that day's
    fault (recorded, and the run goes on) as long as the service still answers a request for data already stored."""


class DownloadCancelled(Exception):
    """SIGTERM/SIGINT arrived; the day in progress was discarded or already committed."""


# ---------------------------------------------------------------------------------------------------------------------
# Dates and day planning


@dataclasses.dataclass(frozen=True)
class StoredDay:
    status: str
    quote_rows: int
    has_intraday_quotes: bool
    # Whether the stored parts hold every expiry (False: stored with the earlier 45-day cap).
    morning_parts_have_all_expiries: bool = True
    intraday_quotes_have_all_expiries: bool = True


@dataclasses.dataclass(frozen=True)
class DayPlan:
    """What one weekday still needs. The morning parts are the 10:00 quotes, the end of day and the open interest. To
    fetch a part replaces the day's rows of it; to complete a part fetches it again and adds only the rows the day lacks
    (a day stored with the earlier 45-day cap)."""

    trading_date: datetime.date
    fetch_morning_parts: bool
    fetch_intraday_quotes: bool
    complete_morning_parts: bool = False
    complete_intraday_quotes: bool = False


def format_utc_timestamp(moment: datetime.datetime) -> str:
    return moment.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def last_finished_session_date(now_eastern: datetime.datetime) -> datetime.date:
    """Today once it is 18:00 ET on a weekday (EOD is built ~17:15 ET); otherwise the last weekday before today."""
    today = now_eastern.date()
    if today.weekday() < 5 and now_eastern.hour >= SESSION_FINISHED_HOUR_EASTERN:
        return today
    candidate = today - datetime.timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= datetime.timedelta(days=1)
    return candidate


def weekdays_between(first_date: datetime.date, last_date: datetime.date) -> list[datetime.date]:
    weekdays = []
    current_date = first_date
    while current_date <= last_date:
        if current_date.weekday() < 5:
            weekdays.append(current_date)
        current_date += datetime.timedelta(days=1)
    return weekdays


def plan_days(start_date: datetime.date, end_date: datetime.date, now_eastern: datetime.datetime,
              stored_days: dict[str, StoredDay]) -> tuple[list[datetime.date], list[DayPlan]]:
    """Returns (weekdays in range up to the last finished session, the work left for those not fully stored). A day is
    fully stored when it has a `days` row and, unless that row says 'no_data', an `intraday_days` row, both holding every
    expiry. A part stored with the earlier 45-day cap is completed."""
    last_date = min(end_date, last_finished_session_date(now_eastern))
    days_in_range = weekdays_between(start_date, last_date)
    day_plans = []
    for trading_date in days_in_range:
        stored_day = stored_days.get(trading_date.isoformat())
        if stored_day is None:
            day_plans.append(DayPlan(trading_date, fetch_morning_parts=True, fetch_intraday_quotes=True))
        elif stored_day.status == "complete":
            complete_morning_parts = not stored_day.morning_parts_have_all_expiries
            fetch_intraday_quotes = not stored_day.has_intraday_quotes
            complete_intraday_quotes = stored_day.has_intraday_quotes and not stored_day.intraday_quotes_have_all_expiries
            if complete_morning_parts or fetch_intraday_quotes or complete_intraday_quotes:
                day_plans.append(DayPlan(trading_date, fetch_morning_parts=False, fetch_intraday_quotes=fetch_intraday_quotes,
                                         complete_morning_parts=complete_morning_parts, complete_intraday_quotes=complete_intraday_quotes))
    return days_in_range, day_plans


# ---------------------------------------------------------------------------------------------------------------------
# Mapping ThetaData frames to rows


def parse_expiry_date(value) -> datetime.date:
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    text = str(value)
    if re.fullmatch(r"\d{8}", text):
        return datetime.date(int(text[0:4]), int(text[4:6]), int(text[6:8]))
    return datetime.date.fromisoformat(text)


def convert_option_right(value) -> str:
    normalized = str(value).strip().upper()
    if normalized in ("CALL", "C"):
        return "C"
    if normalized in ("PUT", "P"):
        return "P"
    raise RequestFailed(f"ThetaData returned an unknown option right: {value!r}")


def price_or_none(value) -> float | None:
    if value is None:
        return None
    number = float(value)
    if math.isnan(number):
        return None
    return round(number, PRICE_DECIMALS)


def integer_or_none(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    return int(value)


def format_quote_timestamp(value) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        raise RequestFailed(f"ThetaData returned a quote timestamp without a time zone: {value!r}")
    return value.isoformat(timespec="milliseconds")


def require_columns(frame, column_names: tuple[str, ...], description: str) -> None:
    missing_columns = [column_name for column_name in column_names if column_name not in frame.columns]
    if missing_columns:
        raise RequestFailed(f"ThetaData {description} response is missing columns {missing_columns} (has {list(frame.columns)})")


def unexpired_contract_rows(frame, trading_date: datetime.date, column_names: tuple[str, ...], description: str):
    """Yields (expiry text, strike, right, named row) for contracts expiring on trading_date or later (an answer can list
    contracts that expired before it, such as the open interest reported the morning after an expiry)."""
    if frame is None or frame.height == 0:
        return
    require_columns(frame, ("expiration", "strike", "right") + column_names, description)
    for row in frame.iter_rows(named=True):
        expiry_date = parse_expiry_date(row["expiration"])
        if expiry_date < trading_date:
            continue
        strike = price_or_none(row["strike"])
        if strike is None:
            logger.warning("%s %s: skipped a row without a strike", description, trading_date.isoformat())
            continue
        yield expiry_date.isoformat(), round(strike, STRIKE_DECIMALS), convert_option_right(row["right"]), row


def deduplicate_by_key(rows: list[tuple], key_length: int, description: str, trading_date: datetime.date) -> list[tuple]:
    """A row's first key_length values are its primary key; keeps the last row per key and warns about repeats."""
    rows_by_key = {}
    for row in rows:
        rows_by_key[row[:key_length]] = row
    duplicate_count = len(rows) - len(rows_by_key)
    if duplicate_count:
        logger.warning("%s %s: %d repeated contracts in the response, kept the last of each", description, trading_date.isoformat(), duplicate_count)
    return list(rows_by_key.values())


def map_quote_rows(frame, trading_date: datetime.date) -> list[tuple]:
    """(trading_date, expiry, strike, right, bid, ask, bid_size, ask_size, quoted_at) for every unexpired contract."""
    trading_date_text = trading_date.isoformat()
    rows = [
        (trading_date_text, expiry, strike, option_right, price_or_none(row["bid"]), price_or_none(row["ask"]),
         integer_or_none(row["bid_size"]), integer_or_none(row["ask_size"]), format_quote_timestamp(row["timestamp"]))
        for expiry, strike, option_right, row in unexpired_contract_rows(frame, trading_date, ("timestamp", "bid", "ask", "bid_size", "ask_size"), "quotes")
    ]
    return deduplicate_by_key(rows, 4, "quotes", trading_date)


def map_end_of_day_rows(frame, trading_date: datetime.date) -> list[tuple]:
    """(trading_date, expiry, strike, right, close, volume, bid, ask) for every unexpired contract. ThetaData reports a
    close of 0 for a contract that did not trade that day (trade count 0); that is stored as no close (NULL)."""
    trading_date_text = trading_date.isoformat()
    rows = []
    for expiry, strike, option_right, row in unexpired_contract_rows(frame, trading_date, ("close", "volume", "count", "bid", "ask"), "eod"):
        traded_that_day = (integer_or_none(row["count"]) or 0) > 0
        rows.append((trading_date_text, expiry, strike, option_right, price_or_none(row["close"]) if traded_that_day else None,
                     integer_or_none(row["volume"]), price_or_none(row["bid"]), price_or_none(row["ask"])))
    return deduplicate_by_key(rows, 4, "eod", trading_date)


def map_open_interest_rows(frame, trading_date: datetime.date) -> list[tuple]:
    """(trading_date, expiry, strike, right, open_interest) for every unexpired contract."""
    trading_date_text = trading_date.isoformat()
    rows = []
    for expiry, strike, option_right, row in unexpired_contract_rows(frame, trading_date, ("open_interest",), "open interest"):
        open_interest = integer_or_none(row["open_interest"])
        if open_interest is None:
            continue
        rows.append((trading_date_text, expiry, strike, option_right, open_interest))
    return deduplicate_by_key(rows, 4, "open interest", trading_date)


def map_intraday_quote_rows(frame, trading_date: datetime.date) -> list[tuple]:
    """(trading_date, look_time, expiry, strike, right, bid, ask, bid_size, ask_size, quoted_at) for every unexpired
    contract, one row per contract and look. ThetaData stamps each row with the look time, not with the time the quote
    was made, so quoted_at is left empty."""
    trading_date_text = trading_date.isoformat()
    rows = []
    rows_off_the_look_grid = 0
    for expiry, strike, option_right, row in unexpired_contract_rows(frame, trading_date, ("timestamp", "bid", "ask", "bid_size", "ask_size"), "intraday quotes"):
        look_timestamp = row["timestamp"]
        if look_timestamp is None or look_timestamp.tzinfo is None:
            raise RequestFailed(f"ThetaData returned an intraday quote without a usable look time: {look_timestamp!r}")
        look_time = look_timestamp.astimezone(EASTERN_TIME_ZONE).strftime("%H:%M")
        if look_time not in INTRADAY_LOOK_TIMES or look_timestamp.astimezone(EASTERN_TIME_ZONE).date() != trading_date:
            rows_off_the_look_grid += 1
            continue
        rows.append((trading_date_text, look_time, expiry, strike, option_right, price_or_none(row["bid"]), price_or_none(row["ask"]),
                     integer_or_none(row["bid_size"]), integer_or_none(row["ask_size"]), None))
    if rows_off_the_look_grid:
        logger.warning("intraday quotes %s: skipped %d rows that are not at a %s look", trading_date_text, rows_off_the_look_grid, INTRADAY_WINDOW)
    return deduplicate_by_key(rows, 5, "intraday quotes", trading_date)


def find_at_the_money_strike(ten_o_clock_quote_rows, trading_date: datetime.date) -> float | None:
    """The strike whose call and put mids at 10:00 are closest, in the nearest expiry at least 1 day out that has a
    strike quoted on both sides. Rows are (trading_date, expiry, strike, right, bid, ask, ...)."""
    mids_by_expiry_and_strike = {}
    for row in ten_o_clock_quote_rows:
        expiry, strike, option_right, bid, ask = row[1:6]
        if bid is None or ask is None or ask <= 0 or bid > ask:
            continue
        if (datetime.date.fromisoformat(expiry) - trading_date).days < 1:
            continue
        mids_by_expiry_and_strike.setdefault(expiry, {}).setdefault(strike, {})[option_right] = (bid + ask) / 2
    for expiry in sorted(mids_by_expiry_and_strike):
        mid_differences = [(abs(mids["C"] - mids["P"]), strike) for strike, mids in mids_by_expiry_and_strike[expiry].items() if len(mids) == 2]
        if mid_differences:
            return min(mid_differences)[1]
    return None


def keep_strikes_within_window(intraday_quote_rows: list[tuple], at_the_money_strike: float, strike_window_pct: float) -> list[tuple]:
    lowest_strike = at_the_money_strike * (1 - strike_window_pct / 100)
    highest_strike = at_the_money_strike * (1 + strike_window_pct / 100)
    return [row for row in intraday_quote_rows if lowest_strike <= row[3] <= highest_strike]


# ---------------------------------------------------------------------------------------------------------------------
# Symbol file


# Schema 4 keeps each option part as slices (symbol_file_slices.py, docs/backtesting/DATA-FILES.md): one row per day,
# look and expiry. The functions below take and give a contract as a row in PART_COLUMN_NAMES' order.
SLICE_TABLE_BY_PART_NAME = {"quotes": "ten_oclock_quote_slices", "intraday_quotes": "intraday_quote_slices", "eod": "end_of_day_slices", "open_interest": "open_interest_slices"}
SLICE_COLUMNS_BY_PART_NAME = {"quotes": slices.TEN_O_CLOCK_QUOTE_COLUMNS, "intraday_quotes": slices.INTRADAY_QUOTE_COLUMNS, "eod": slices.END_OF_DAY_COLUMNS,
                              "open_interest": slices.OPEN_INTEREST_COLUMNS}
# The slice row flag each table keeps: whether any ask is above 0 (10:00 quotes) or any volume is there (end of day).
SLICE_FLAG_BY_PART_NAME = {"quotes": ("has_ask_above_zero", lambda row: row[3] is not None and row[3] > 0), "eod": ("has_volume", lambda row: row[3] is not None)}


def slice_key_and_row(part_name: str, row: tuple) -> tuple[int, tuple]:
    """A part row as its slice's key and the slice's columns."""
    trading_date = datetime.date.fromisoformat(row[0])
    day_number = slices.day_number_of(trading_date)
    if part_name == "intraday_quotes":
        _, look_time, expiry, strike, option_right, bid, ask, bid_size, ask_size, quoted_at = row
        if quoted_at is not None:
            raise DownloadFailed(f"an intraday quote on {row[0]} at {look_time} has a quote time; schema 4 keeps none for intraday looks")
        return slices.slice_key(day_number, slices.look_minute_of(look_time), (datetime.date.fromisoformat(expiry) - trading_date).days), (strike, option_right, bid, ask, bid_size, ask_size)
    days_to_expiry = (datetime.date.fromisoformat(row[1]) - trading_date).days
    if part_name == "quotes":
        strike, option_right, bid, ask, bid_size, ask_size, quoted_at = row[2:]
        quote_time = None if quoted_at is None else slices.milliseconds_before_ten_o_clock(trading_date, quoted_at)
        return slices.slice_key(day_number, slices.TEN_O_CLOCK_LOOK_MINUTE, days_to_expiry), (strike, option_right, bid, ask, bid_size, ask_size, quote_time)
    return slices.slice_key(day_number, slices.DAILY_SLICE_LOOK_MINUTE, days_to_expiry), tuple(row[2:])


def part_row_of_slice_row(part_name: str, key: int, slice_row: tuple) -> tuple:
    """slice_key_and_row's inverse."""
    trading_date = slices.date_of_day_number(slices.day_number_of_key(key))
    expiry_text = (trading_date + datetime.timedelta(days=slices.days_to_expiry_of_key(key))).isoformat()
    if part_name == "intraday_quotes":
        return (trading_date.isoformat(), slices.look_time_of_minute(slices.look_minute_of_key(key)), expiry_text) + tuple(slice_row) + (None,)
    if part_name == "quotes":
        quote_time = slice_row[6]
        return (trading_date.isoformat(), expiry_text) + tuple(slice_row[:6]) + (None if quote_time is None else slices.quoted_at_text_of(trading_date, quote_time),)
    return (trading_date.isoformat(), expiry_text) + tuple(slice_row)


def day_key_range(trading_date_text: str) -> tuple[int, int]:
    day_number = slices.day_number_of(datetime.date.fromisoformat(trading_date_text))
    return slices.slice_key(day_number, 0, 0), slices.slice_key(day_number + 1, 0, 0) - 1


def read_slices(connection: sqlite3.Connection, part_name: str, first_key: int, last_key: int) -> list[tuple[int, list[tuple]]]:
    """(key, the slice's rows) of the part's slices between two keys, in key order."""
    columns = SLICE_COLUMNS_BY_PART_NAME[part_name]
    return [(key, slices.unpack_slice(data, columns)) for key, data in connection.execute(
        f"SELECT key, data FROM {SLICE_TABLE_BY_PART_NAME[part_name]} WHERE key BETWEEN ? AND ? ORDER BY key", (first_key, last_key))]


def write_slice(connection: sqlite3.Connection, part_name: str, key: int, slice_rows: list[tuple]) -> None:
    """Stores a slice's rows (any order: kept in strike order, the Call before the Put), replacing a stored slice of that key."""
    slice_rows = sorted(slice_rows, key=lambda slice_row: (slice_row[0], slice_row[1]))
    call_count, put_count = slices.slice_counts(slice_rows)
    data = slices.pack_slice(slice_rows, SLICE_COLUMNS_BY_PART_NAME[part_name])
    table_name = SLICE_TABLE_BY_PART_NAME[part_name]
    if part_name in SLICE_FLAG_BY_PART_NAME:
        flag_column, flagged = SLICE_FLAG_BY_PART_NAME[part_name]
        connection.execute(f"INSERT OR REPLACE INTO {table_name} (key, call_count, put_count, {flag_column}, data) VALUES (?, ?, ?, ?, ?)",
                           (key, call_count, put_count, int(any(flagged(slice_row) for slice_row in slice_rows)), data))
    else:
        connection.execute(f"INSERT OR REPLACE INTO {table_name} (key, call_count, put_count, data) VALUES (?, ?, ?, ?)", (key, call_count, put_count, data))


def delete_part_rows_of_day(connection: sqlite3.Connection, part_name: str, trading_date_text: str) -> None:
    connection.execute(f"DELETE FROM {SLICE_TABLE_BY_PART_NAME[part_name]} WHERE key BETWEEN ? AND ?", day_key_range(trading_date_text))


def merge_part_rows(connection: sqlite3.Connection, part_name: str, rows: list[tuple], on_stored_contract: str) -> int:
    """Adds rows to their slices. A contract stored already (or twice among the rows) raises IntegrityError
    ('fail'), keeps its stored values ('keep') or takes the new ones ('replace'). Returns how many
    contracts were added."""
    rows_by_key: dict[int, list[tuple]] = collections.defaultdict(list)
    for row in rows:
        key, slice_row = slice_key_and_row(part_name, row)
        rows_by_key[key].append(slice_row)
    added = 0
    for key, new_rows in sorted(rows_by_key.items()):
        stored = read_slices(connection, part_name, key, key)
        merged = {(slice_row[0], slice_row[1]): slice_row for slice_row in (stored[0][1] if stored else [])}
        for slice_row in new_rows:
            contract = (slice_row[0], slice_row[1])
            if contract not in merged:
                added += 1
                merged[contract] = slice_row
            elif on_stored_contract == "fail":
                raise sqlite3.IntegrityError(f"UNIQUE constraint failed: {part_name} contract {contract} in slice {key}")
            elif on_stored_contract == "replace":
                merged[contract] = slice_row
        write_slice(connection, part_name, key, list(merged.values()))
    return added


def insert_part_rows(connection: sqlite3.Connection, part_name: str, rows: list[tuple], replace_stored_rows: bool = False) -> None:
    merge_part_rows(connection, part_name, rows, "replace" if replace_stored_rows else "fail")


def add_missing_part_rows(connection: sqlite3.Connection, part_name: str, rows: list[tuple]) -> int:
    """Adds the rows the day does not hold yet (by contract), leaving the stored ones as they are; returns how many."""
    return merge_part_rows(connection, part_name, rows, "keep")


def read_part_rows(connection: sqlite3.Connection, part_name: str, trading_date_text: str | None = None) -> list[tuple]:
    """The part's rows of one day (or of every day), in PART_COLUMN_NAMES' order, by day, look, expiry, strike and right."""
    first_key, last_key = day_key_range(trading_date_text) if trading_date_text is not None else (0, 2 ** 62)
    return [part_row_of_slice_row(part_name, key, slice_row) for key, slice_rows in read_slices(connection, part_name, first_key, last_key) for slice_row in slice_rows]


def count_part_rows(connection: sqlite3.Connection, part_name: str, trading_date_text: str) -> int:
    return connection.execute(f"SELECT coalesce(sum(call_count + put_count), 0) FROM {SLICE_TABLE_BY_PART_NAME[part_name]} WHERE key BETWEEN ? AND ?",
                              day_key_range(trading_date_text)).fetchone()[0]


def count_intraday_rows_and_looks(connection: sqlite3.Connection, trading_date_text: str) -> tuple[int, int]:
    """(the day's intraday quotes, its distinct look times)."""
    return connection.execute("SELECT coalesce(sum(call_count + put_count), 0), count(DISTINCT (key / 65536) % 65536) FROM intraday_quote_slices WHERE key BETWEEN ? AND ?",
                              day_key_range(trading_date_text)).fetchone()


def part_has_rows(connection: sqlite3.Connection, part_name: str, trading_date_text: str, expiry_text: str | None) -> bool:
    """Whether the day holds rows of the part (of one expiration, when given)."""
    first_key, last_key = day_key_range(trading_date_text)
    if expiry_text is None:
        return connection.execute(f"SELECT 1 FROM {SLICE_TABLE_BY_PART_NAME[part_name]} WHERE key BETWEEN ? AND ? LIMIT 1", (first_key, last_key)).fetchone() is not None
    days_to_expiry = (datetime.date.fromisoformat(expiry_text) - datetime.date.fromisoformat(trading_date_text)).days
    return connection.execute(f"SELECT 1 FROM {SLICE_TABLE_BY_PART_NAME[part_name]} WHERE key BETWEEN ? AND ? AND key % 65536 = ? LIMIT 1",
                              (first_key, last_key, days_to_expiry)).fetchone() is not None


def open_symbol_file(file_path: Path, symbol: str, now_utc: datetime.datetime) -> sqlite3.Connection:
    """Opens (creating if needed) the symbol file, adds whatever tables, columns and meta keys an older file lacks
    (which makes it a file of SCHEMA_VERSION), and checks its meta matches this download."""
    connection = sqlite3.connect(file_path, isolation_level=None)
    try:
        connection.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MILLISECONDS}")
        # Only schema 4 files are written: an earlier file is refused.
        has_meta = connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").fetchone() is not None
        stored_version = connection.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone() if has_meta else None
        if stored_version is not None and stored_version[0] != SCHEMA_VERSION:
            raise DownloadFailed(f"{file_path} has schema version {stored_version[0]}; this downloader writes version {SCHEMA_VERSION}: move the file away "
                                 "and download the symbol again")
        if connection.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] == 0:
            connection.execute(f"PRAGMA page_size = {NEW_FILE_PAGE_SIZE}")
        connection.execute("BEGIN IMMEDIATE")
        for statement in SCHEMA_STATEMENTS:
            connection.execute(statement)
        expected_meta = {
            "symbol": symbol,
            "schema_version": SCHEMA_VERSION,
            "quote_time_et": QUOTE_TIME_EASTERN,
            "max_dte": MAX_DTE_META,
            "intraday_interval": INTRADAY_INTERVAL,
            "intraday_window": INTRADAY_WINDOW,
        }
        connection.executemany("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
                               list(expected_meta.items()) + [("created_at", format_utc_timestamp(now_utc))])
        connection.execute("COMMIT")
        stored_meta = dict(connection.execute("SELECT key, value FROM meta").fetchall())
        mismatched_keys = [key for key, value in expected_meta.items() if stored_meta.get(key) != value]
        if mismatched_keys:
            details = ", ".join(f"{key}={stored_meta.get(key)!r} (expected {expected_meta[key]!r})" for key in mismatched_keys)
            raise DownloadFailed(f"{file_path} does not match this download: {details}")
        return connection
    except BaseException:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        connection.close()
        raise


def read_stored_days(connection: sqlite3.Connection) -> dict[str, StoredDay]:
    return {
        trading_date: StoredDay(status, quote_rows, bool(has_intraday_quotes), bool(morning_all_expiries), not has_intraday_quotes or bool(intraday_all_expiries))
        for trading_date, status, quote_rows, has_intraday_quotes, morning_all_expiries, intraday_all_expiries in connection.execute(
            """SELECT d.trading_date, d.status, d.quote_rows, i.trading_date IS NOT NULL, d.all_expiries, i.all_expiries
               FROM days d LEFT JOIN intraday_days i ON i.trading_date = d.trading_date""")
    }


def count_days_needing_attention(connection: sqlite3.Connection, first_date: datetime.date, last_date: datetime.date) -> tuple[int, int]:
    """(days recorded as unavailable, days stored with something left out) between the two dates."""
    date_range = (first_date.isoformat(), last_date.isoformat())
    unavailable_days = connection.execute("SELECT count(*) FROM unavailable_days WHERE trading_date BETWEEN ? AND ?", date_range).fetchone()[0]
    days_with_issues = connection.execute("SELECT count(DISTINCT trading_date) FROM day_issues WHERE trading_date BETWEEN ? AND ?", date_range).fetchone()[0]
    return unavailable_days, days_with_issues


@dataclasses.dataclass
class DayPartResult:
    """One part of one day as retrieved. `issues` lists what had to be left out: (expiration, or None for the whole
    part; why)."""

    rows: list[tuple]
    issues: list[tuple[str | None, str]] = dataclasses.field(default_factory=list)

    @property
    def nothing_retrieved(self) -> bool:
        """The part failed and no expiration could be retrieved one by one either."""
        return bool(self.issues) and not self.rows


@dataclasses.dataclass
class DayOutcome:
    day_done: bool
    unavailable_reason: str | None = None
    status: str | None = None
    quote_rows: int = 0
    end_of_day_rows: int | None = None
    open_interest_rows: int | None = None
    intraday_quote_rows: int | None = None
    intraday_look_count: int | None = None
    issue_count: int = 0
    # Per part stored with rows: one of its expirations, for the service check of later days.
    reference_expiry_by_part_name: dict[str, str] = dataclasses.field(default_factory=dict)
    # Per part completed to every expiry: the rows it added.
    added_rows_by_part_name: dict[str, int] = dataclasses.field(default_factory=dict)
    # Parts that could not be completed (nothing retrieved): the day keeps what it has and is completed on a later run.
    completion_failures: list[str] = dataclasses.field(default_factory=list)


def describe_unavailable_part(part_label: str, part_result: DayPartResult) -> str:
    other_failures = len(part_result.issues) - 1
    return f"{part_label}: {part_result.issues[0][1]}" + (f" (and {other_failures} more expirations failed)" if other_failures > 0 else "")


def record_unavailable_day(connection: sqlite3.Connection, trading_date_text: str, reason: str, attempted_at_text: str) -> None:
    connection.execute(
        """INSERT INTO unavailable_days (trading_date, reason, attempts, last_attempt_at) VALUES (?, ?, 1, ?)
           ON CONFLICT (trading_date) DO UPDATE SET reason = excluded.reason, attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at""",
        (trading_date_text, reason, attempted_at_text))


def replace_day_issues(connection: sqlite3.Connection, trading_date_text: str, part_results: dict[str, DayPartResult], recorded_at_text: str,
                       record_parts_without_data: bool) -> int:
    """Rewrites the day's issues of these parts: what each had to leave out and, with record_parts_without_data (a day
    that has data), each part ThetaData answered with no data at all."""
    issue_count = 0
    for part_name, part_result in part_results.items():
        issues = list(part_result.issues)
        if record_parts_without_data and not part_result.rows and not issues:
            issues.append((None, NO_DATA_RETURNED_MESSAGE))
        connection.execute("DELETE FROM day_issues WHERE trading_date = ? AND part = ?", (trading_date_text, part_name))
        connection.executemany(
            "INSERT INTO day_issues (trading_date, part, expiry, message, recorded_at) VALUES (?, ?, ?, ?, ?)",
            [(trading_date_text, part_name, expiry, message, recorded_at_text) for expiry, message in issues])
        issue_count += len(issues)
    return issue_count


PART_COLUMN_NAMES = {
    "quotes": ("trading_date", "expiry", "strike", "option_right", "bid", "ask", "bid_size", "ask_size", "quoted_at"),
    "eod": ("trading_date", "expiry", "strike", "option_right", "close", "volume", "bid", "ask"),
    "open_interest": ("trading_date", "expiry", "strike", "option_right", "open_interest"),
    "intraday_quotes": ("trading_date", "look_time", "expiry", "strike", "option_right", "bid", "ask", "bid_size", "ask_size", "quoted_at"),
}
ROW_COUNT_COLUMN_BY_MORNING_PART_NAME = {"quotes": "quote_rows", "eod": "eod_rows", "open_interest": "open_interest_rows"}


def settle_day_issues_after_completion(connection: sqlite3.Connection, trading_date_text: str, part_results: dict[str, DayPartResult], recorded_at_text: str) -> int:
    """After parts of a stored day were completed: an issue the day now holds rows for is settled (an expiration with
    rows, or a whole part with any row); what the completion left out is recorded (or its message brought up to date).
    Returns the issues recorded."""
    issue_count = 0
    for part_name, part_result in part_results.items():
        for (expiry_text,) in connection.execute("SELECT DISTINCT expiry FROM day_issues WHERE trading_date = ? AND part = ?", (trading_date_text, part_name)).fetchall():
            if part_has_rows(connection, part_name, trading_date_text, expiry_text):
                connection.execute("DELETE FROM day_issues WHERE trading_date = ? AND part = ? AND expiry IS ?", (trading_date_text, part_name, expiry_text))
        for expiry_text, message in part_result.issues:
            updated = connection.execute("UPDATE day_issues SET message = ?, recorded_at = ? WHERE trading_date = ? AND part = ? AND expiry IS ?",
                                         (message, recorded_at_text, trading_date_text, part_name, expiry_text)).rowcount
            if not updated:
                connection.execute("INSERT INTO day_issues (trading_date, part, expiry, message, recorded_at) VALUES (?, ?, ?, ?, ?)",
                                   (trading_date_text, part_name, expiry_text, message, recorded_at_text))
            issue_count += 1
    return issue_count


def keep_intraday_quotes_within_strike_window(connection: sqlite3.Connection, trading_date: datetime.date, intraday_quote_rows: list[tuple],
                                              strike_window_pct: float | None, ten_o_clock_quote_rows=None) -> tuple[list[tuple], float | None]:
    """(the rows within strike_window_pct of the day's at-the-money strike, the window applied). Every row and no window
    when none is asked for or the day has no strike quoted on both sides at 10:00. The 10:00 quotes are read from the
    file unless given."""
    if strike_window_pct is None or not intraday_quote_rows:
        return intraday_quote_rows, None
    if ten_o_clock_quote_rows is None:
        ten_o_clock_quote_rows = read_part_rows(connection, "quotes", trading_date.isoformat())
    at_the_money_strike = find_at_the_money_strike(ten_o_clock_quote_rows, trading_date)
    if at_the_money_strike is None:
        logger.warning("%s: no strike quoted on both sides at 10:00, intraday quotes kept for every strike", trading_date.isoformat())
        return intraday_quote_rows, None
    return keep_strikes_within_window(intraday_quote_rows, at_the_money_strike, strike_window_pct), strike_window_pct


def store_day_in_open_transaction(connection: sqlite3.Connection, day_plan: DayPlan, part_results: dict[str, DayPartResult],
                                  strike_window_pct: float | None, stored_at_text: str, no_data_is_final_through: datetime.date) -> DayOutcome:
    trading_date_text = day_plan.trading_date.isoformat()
    outcome = DayOutcome(day_done=False)
    ten_o_clock_quote_rows = None

    if day_plan.fetch_morning_parts:
        morning_results = {day_part.name: part_results[day_part.name] for day_part in MORNING_PARTS}
        for day_part in MORNING_PARTS:
            if morning_results[day_part.name].nothing_retrieved:
                outcome.unavailable_reason = describe_unavailable_part(day_part.label, morning_results[day_part.name])
                record_unavailable_day(connection, trading_date_text, outcome.unavailable_reason, stored_at_text)
                return outcome
        quotes, end_of_day, open_interest = morning_results["quotes"], morning_results["eod"], morning_results["open_interest"]
        outcome.status = "complete" if (quotes.rows or end_of_day.rows or open_interest.rows) else "no_data"
        if outcome.status == "no_data" and day_plan.trading_date > no_data_is_final_through:
            outcome.status = None
            outcome.unavailable_reason = NOT_PUBLISHED_YET_REASON
            record_unavailable_day(connection, trading_date_text, outcome.unavailable_reason, stored_at_text)
            return outcome
        for part_name, part_result in morning_results.items():
            delete_part_rows_of_day(connection, part_name, trading_date_text)
            insert_part_rows(connection, part_name, part_result.rows)
            if part_result.rows:
                outcome.reference_expiry_by_part_name[part_name] = min(row[1] for row in part_result.rows)
        connection.execute(
            "INSERT INTO days (trading_date, status, quote_rows, eod_rows, open_interest_rows, fetched_at, all_expiries) VALUES (?, ?, ?, ?, ?, ?, 1)",
            (trading_date_text, outcome.status, len(quotes.rows), len(end_of_day.rows), len(open_interest.rows), stored_at_text))
        outcome.issue_count += replace_day_issues(connection, trading_date_text, morning_results, stored_at_text, record_parts_without_data=outcome.status == "complete")
        outcome.quote_rows, outcome.end_of_day_rows, outcome.open_interest_rows = len(quotes.rows), len(end_of_day.rows), len(open_interest.rows)
        ten_o_clock_quote_rows = quotes.rows
        if outcome.status == "no_data":
            delete_part_rows_of_day(connection, "intraday_quotes", trading_date_text)
            connection.execute("DELETE FROM intraday_days WHERE trading_date = ?", (trading_date_text,))
    else:
        outcome.status, outcome.quote_rows = connection.execute("SELECT status, quote_rows FROM days WHERE trading_date = ?", (trading_date_text,)).fetchone()
        if outcome.status == "complete" and day_plan.complete_morning_parts:
            morning_results = {day_part.name: part_results[day_part.name] for day_part in MORNING_PARTS}
            failed_part = next((day_part for day_part in MORNING_PARTS if morning_results[day_part.name].nothing_retrieved), None)
            if failed_part is not None:
                outcome.completion_failures.append(describe_unavailable_part(failed_part.label, morning_results[failed_part.name]))
            else:
                for part_name, part_result in morning_results.items():
                    outcome.added_rows_by_part_name[part_name] = add_missing_part_rows(connection, part_name, part_result.rows)
                    if part_result.rows:
                        outcome.reference_expiry_by_part_name[part_name] = min(row[1] for row in part_result.rows)
                connection.execute(
                    "UPDATE days SET quote_rows = ?, eod_rows = ?, open_interest_rows = ?, all_expiries = 1 WHERE trading_date = ?",
                    tuple(count_part_rows(connection, part_name, trading_date_text) for part_name in ("quotes", "eod", "open_interest")) + (trading_date_text,))
                outcome.issue_count += settle_day_issues_after_completion(connection, trading_date_text, morning_results, stored_at_text)
                outcome.quote_rows = connection.execute("SELECT quote_rows FROM days WHERE trading_date = ?", (trading_date_text,)).fetchone()[0]

    if outcome.status == "complete" and day_plan.complete_intraday_quotes:
        intraday_quotes = part_results["intraday_quotes"]
        if intraday_quotes.nothing_retrieved:
            outcome.completion_failures.append(describe_unavailable_part(INTRADAY_QUOTES_PART.label, intraday_quotes))
        else:
            stored_strike_window_pct = connection.execute("SELECT strike_window_pct FROM intraday_days WHERE trading_date = ?", (trading_date_text,)).fetchone()[0]
            intraday_quote_rows, _ = keep_intraday_quotes_within_strike_window(connection, day_plan.trading_date, intraday_quotes.rows, stored_strike_window_pct)
            outcome.added_rows_by_part_name["intraday_quotes"] = add_missing_part_rows(connection, "intraday_quotes", intraday_quote_rows)
            outcome.intraday_quote_rows, outcome.intraday_look_count = count_intraday_rows_and_looks(connection, trading_date_text)
            connection.execute(
                "UPDATE intraday_days SET quote_rows = ?, look_count = ?, status = CASE WHEN ? > 0 THEN 'complete' ELSE status END, all_expiries = 1 WHERE trading_date = ?",
                (outcome.intraday_quote_rows, outcome.intraday_look_count, outcome.intraday_quote_rows, trading_date_text))
            outcome.issue_count += settle_day_issues_after_completion(connection, trading_date_text, {"intraday_quotes": intraday_quotes}, stored_at_text)
            if intraday_quote_rows:
                outcome.reference_expiry_by_part_name["intraday_quotes"] = min(row[2] for row in intraday_quote_rows)

    if outcome.status == "complete" and day_plan.fetch_intraday_quotes:
        intraday_quotes = part_results["intraday_quotes"]
        if intraday_quotes.nothing_retrieved:
            outcome.unavailable_reason = describe_unavailable_part(INTRADAY_QUOTES_PART.label, intraday_quotes)
            record_unavailable_day(connection, trading_date_text, outcome.unavailable_reason, stored_at_text)
            return outcome
        intraday_quote_rows, applied_strike_window_pct = keep_intraday_quotes_within_strike_window(
            connection, day_plan.trading_date, intraday_quotes.rows, strike_window_pct, ten_o_clock_quote_rows)
        delete_part_rows_of_day(connection, "intraday_quotes", trading_date_text)
        connection.execute("DELETE FROM intraday_days WHERE trading_date = ?", (trading_date_text,))
        insert_part_rows(connection, "intraday_quotes", intraday_quote_rows)
        outcome.intraday_quote_rows = len(intraday_quote_rows)
        outcome.intraday_look_count = len({row[1] for row in intraday_quote_rows})
        connection.execute(
            "INSERT INTO intraday_days (trading_date, status, look_count, quote_rows, strike_window_pct, fetched_at, all_expiries) VALUES (?, ?, ?, ?, ?, ?, 1)",
            (trading_date_text, "complete" if intraday_quotes.rows else "no_data", outcome.intraday_look_count, outcome.intraday_quote_rows,
             applied_strike_window_pct, stored_at_text))
        outcome.issue_count += replace_day_issues(connection, trading_date_text, {"intraday_quotes": intraday_quotes}, stored_at_text, record_parts_without_data=True)
        if intraday_quote_rows:
            outcome.reference_expiry_by_part_name["intraday_quotes"] = min(row[2] for row in intraday_quote_rows)

    connection.execute("DELETE FROM unavailable_days WHERE trading_date = ?", (trading_date_text,))
    outcome.day_done = not outcome.completion_failures
    return outcome


def store_day(connection: sqlite3.Connection, day_plan: DayPlan, part_results: dict[str, DayPartResult], strike_window_pct: float | None,
              stored_at_utc: datetime.datetime, no_data_is_final_through: datetime.date) -> DayOutcome:
    """Stores what was retrieved for one day in one transaction: the rows of each part fetched, their `days` and
    `intraday_days` rows and what was left out (day_issues). A day with a part that could not be retrieved at all (its
    10:00 quotes, end of day or open interest; or its intraday quotes) gets an unavailable_days row instead: nothing of
    its morning parts is stored (the intraday quotes alone leave them as they are), and it is asked for again on the
    next run. So does a day with no data in any part that is after no_data_is_final_through (not published yet). A part
    being completed that could not be retrieved at all leaves the day as it was: it is completed on a later run."""
    connection.execute("BEGIN IMMEDIATE")
    try:
        outcome = store_day_in_open_transaction(connection, day_plan, part_results, strike_window_pct, format_utc_timestamp(stored_at_utc), no_data_is_final_through)
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    return outcome


# ---------------------------------------------------------------------------------------------------------------------
# ThetaData requests


def grpc_status_name(error: grpc.RpcError) -> str:
    code_function = getattr(error, "code", None)
    status_code = code_function() if callable(code_function) else None
    return status_code.name if status_code is not None else "UNKNOWN"


def grpc_error_details(error: grpc.RpcError) -> str:
    details_function = getattr(error, "details", None)
    details = details_function() if callable(details_function) else None
    return details or str(error)


class ThetaDataSession:
    """The logged-in client every request uses. ThetaData allows one login per API key at a time: a later login (a
    probe, a second downloader) invalidates this one, and its requests then fail with 'Invalid session ID'. When that
    happens this waits, logs in again and the request is repeated, at most
    len(WAITS_BEFORE_LOGIN_AFTER_SESSION_LOSS_SECONDS) times per run."""

    def __init__(self, client_factory, stop_requested: threading.Event, waits_before_login_seconds=WAITS_BEFORE_LOGIN_AFTER_SESSION_LOSS_SECONDS):
        self.client_factory = client_factory
        self.stop_requested = stop_requested
        self.waits_before_login_seconds = waits_before_login_seconds
        self.lock = threading.Lock()
        self.client = client_factory()
        self.logins_after_session_loss = 0

    def current(self):
        """(client, its login number). Blocks while another request is logging in again."""
        with self.lock:
            return self.client, self.logins_after_session_loss

    def log_in_again_after_session_loss(self, lost_login_number: int, description: str) -> None:
        with self.lock:
            if self.logins_after_session_loss != lost_login_number:
                return
            if self.logins_after_session_loss == len(self.waits_before_login_seconds):
                raise DownloadFailed(
                    f"another ThetaData login keeps taking the session ({self.logins_after_session_loss} new logins did not hold): "
                    f"only one program may use the API key at a time")
            wait_seconds = self.waits_before_login_seconds[self.logins_after_session_loss]
            logger.warning("%s: another ThetaData login took the session; logging in again in %s s (new login %d of at most %d)", description, wait_seconds,
                           self.logins_after_session_loss + 1, len(self.waits_before_login_seconds))
            if self.stop_requested.wait(wait_seconds):
                raise DownloadCancelled()
            self.client = self.client_factory()
            self.logins_after_session_loss += 1


def fetch_frame_with_retries(session: ThetaDataSession, perform_request, description: str, retry_delays_seconds=RETRY_DELAYS_SECONDS, sleep=time.sleep):
    """Returns the frame of perform_request(client), or None when ThetaData has no data. A session taken by another
    login is logged in again and the request repeated. Any other permission or authentication refusal raises
    RequestRefused at once. Transient gRPC errors, and answers the library cannot decode, are retried with backoff;
    RequestFailed once the retries are used up or the error is not one that passes."""
    attempt_index = 0
    while True:
        client, login_number = session.current()
        try:
            return perform_request(client)
        except NoDataFoundError:
            return None
        except grpc.RpcError as error:
            status_name = grpc_status_name(error)
            details = grpc_error_details(error)
            failure = f"{status_name}: {details}"
            if status_name == SESSION_LOST_GRPC_STATUS_NAME and SESSION_LOST_DETAILS_MARKER in details.lower():
                session.log_in_again_after_session_loss(login_number, description)
                continue
            if status_name in REFUSED_GRPC_STATUS_NAMES:
                raise RequestRefused(
                    f"ThetaData refused {description} ({failure}). The API key or subscription does not allow this "
                    f"request (the options VALUE plan covers 2020-01-01 onwards).") from None
            may_pass_on_retry = status_name in TRANSIENT_GRPC_STATUS_NAMES
        except Exception as error:
            failure = f"{type(error).__name__}: {error}"
            may_pass_on_retry = True
        if not may_pass_on_retry or attempt_index == len(retry_delays_seconds):
            raise RequestFailed(f"ThetaData request {description} failed ({failure})")
        delay_seconds = retry_delays_seconds[attempt_index]
        logger.warning("%s: %s, retrying in %s s", description, failure, delay_seconds)
        sleep(delay_seconds)
        attempt_index += 1


def request_quotes(client, symbol: str, trading_date: datetime.date, expiration):
    return client.option_at_time_quote(symbol, trading_date, trading_date, QUOTE_TIME_EASTERN, expiration)


def request_end_of_day(client, symbol: str, trading_date: datetime.date, expiration):
    return client.option_history_eod(trading_date, trading_date, symbol, expiration)


def request_open_interest(client, symbol: str, trading_date: datetime.date, expiration):
    return client.option_history_open_interest(symbol, expiration, date=trading_date)


def request_intraday_quotes(client, symbol: str, trading_date: datetime.date, expiration):
    return client.option_history_quote(symbol, expiration, interval=INTRADAY_INTERVAL, date=trading_date,
                                       start_time=INTRADAY_FIRST_LOOK_EASTERN, end_time=INTRADAY_LAST_LOOK_EASTERN)


@dataclasses.dataclass(frozen=True)
class DayPart:
    """One request per trading day. `name` is the table its rows go to and the `part` of its day_issues rows."""

    name: str
    # The cap a file stored before every expiry was kept held: completing the part asks expiration by expiration only
    # beyond it.
    earlier_max_days_to_expiry: int
    perform_request: object
    map_rows: object
    # How many leading values of a mapped row are its primary key in the table; the expiry is the third from its end.
    key_length: int
    # What the part is called in a reason or an error.
    label: str


MORNING_PARTS = (
    DayPart("quotes", EARLIER_QUOTE_MAX_DAYS_TO_EXPIRY, request_quotes, map_quote_rows, 4, "quotes at 10:00"),
    DayPart("eod", EARLIER_END_OF_DAY_AND_OPEN_INTEREST_MAX_DAYS_TO_EXPIRY, request_end_of_day, map_end_of_day_rows, 4, "end of day"),
    DayPart("open_interest", EARLIER_END_OF_DAY_AND_OPEN_INTEREST_MAX_DAYS_TO_EXPIRY, request_open_interest, map_open_interest_rows, 4, "open interest"),
)
INTRADAY_QUOTES_PART = DayPart("intraday_quotes", EARLIER_QUOTE_MAX_DAYS_TO_EXPIRY, request_intraday_quotes, map_intraday_quote_rows, 5, "intraday quotes")
DAY_PART_BY_NAME = {day_part.name: day_part for day_part in MORNING_PARTS + (INTRADAY_QUOTES_PART,)}


class StoredDataReferences:
    """Per part, a day and expiration whose data is in the file. Asking for it again tells a day ThetaData cannot serve
    (the reference still answers) from a service problem (it does not). A part the file holds no rows of has none.
    Set by the main thread, read by the requests."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reference_by_part_name = {}

    def set(self, part_names, trading_date: datetime.date, expiry_text: str | None) -> None:
        if expiry_text is None:
            return
        with self.lock:
            for part_name in part_names:
                self.reference_by_part_name[part_name] = (trading_date, datetime.date.fromisoformat(expiry_text))

    def get(self, part_name: str) -> tuple[datetime.date, datetime.date] | None:
        with self.lock:
            return self.reference_by_part_name.get(part_name)


def read_stored_data_references(connection: sqlite3.Connection) -> StoredDataReferences:
    """Per part, the latest day the file holds rows of, with one of its expirations."""
    references = StoredDataReferences()
    for part_name in DAY_PART_BY_NAME:
        latest_key = connection.execute(f"SELECT max(key) FROM {SLICE_TABLE_BY_PART_NAME[part_name]}").fetchone()[0]
        if latest_key is None:
            continue
        latest_date = slices.date_of_day_number(slices.day_number_of_key(latest_key))
        nearest_days_to_expiry = connection.execute(f"SELECT min(key % 65536) FROM {SLICE_TABLE_BY_PART_NAME[part_name]} WHERE key BETWEEN ? AND ?",
                                                    day_key_range(latest_date.isoformat())).fetchone()[0]
        references.set([part_name], latest_date, (latest_date + datetime.timedelta(days=nearest_days_to_expiry)).isoformat())
    return references


def fetch_part_rows(session: ThetaDataSession, symbol: str, trading_date: datetime.date, day_part: DayPart, expiration, retry_delays_seconds) -> list[tuple]:
    expirations_label = "all expirations" if expiration == ALL_EXPIRATIONS else f"expiration {expiration.isoformat()}"
    description = f"{day_part.name} {symbol} {trading_date.isoformat()} {expirations_label}"
    frame = fetch_frame_with_retries(session, lambda client: day_part.perform_request(client, symbol, trading_date, expiration), description, retry_delays_seconds)
    try:
        return day_part.map_rows(frame, trading_date)
    except DownloadFailed:
        raise
    except Exception as error:
        raise RequestFailed(f"ThetaData request {description} returned rows that cannot be used ({type(error).__name__}: {error})") from None


def confirm_service_still_answers(session: ThetaDataSession, symbol: str, day_part: DayPart, references: StoredDataReferences, failed_request: str, retry_delays_seconds) -> None:
    """Raises DownloadFailed unless ThetaData answers the same kind of request for data already in the file (or, while
    the file has none, a request for the symbol's expirations)."""
    reference = references.get(day_part.name)
    try:
        if reference is None:
            answered = fetch_frame_with_retries(session, lambda client: client.option_list_expirations(symbol), f"expirations {symbol}", retry_delays_seconds) is not None
        else:
            reference_date, reference_expiration = reference
            answered = bool(fetch_part_rows(session, symbol, reference_date, day_part, reference_expiration, retry_delays_seconds))
    except RequestFailed as error:
        raise DownloadFailed(f"{failed_request}, and a request that worked before fails too ({error}): ThetaData is having a problem, nothing was recorded for this day") from None
    if not answered:
        raise DownloadFailed(f"{failed_request}, and a request for data already stored now returns nothing: ThetaData is having a problem, nothing was recorded for this day")


def fetch_day_part(session: ThetaDataSession, symbol: str, trading_date: datetime.date, day_part: DayPart, expiration_dates: list[datetime.date],
                   references: StoredDataReferences, retry_delays_seconds, expiration_by_expiration_retry_delays_seconds, completing: bool = False) -> DayPartResult:
    """One part of one day: one request for all expirations. If that keeps failing while the service still answers for
    stored data, each expiration in range is asked for on its own (completing a day stored with the earlier cap: only
    those beyond it); what comes back is kept and the rest listed."""
    try:
        return DayPartResult(fetch_part_rows(session, symbol, trading_date, day_part, ALL_EXPIRATIONS, retry_delays_seconds))
    except RequestFailed as error:
        failed_request = str(error)
    logger.warning("%s; checking the service, then asking for each expiration on its own", failed_request)
    confirm_service_still_answers(session, symbol, day_part, references, failed_request, expiration_by_expiration_retry_delays_seconds)
    first_expiration_date = trading_date + datetime.timedelta(days=day_part.earlier_max_days_to_expiry + 1 if completing else 0)
    last_expiration_date = trading_date + datetime.timedelta(days=EXPIRATION_BY_EXPIRATION_MAX_DAYS_TO_EXPIRY)
    result = DayPartResult([])
    expirations_in_range = [expiration_date for expiration_date in expiration_dates if first_expiration_date <= expiration_date <= last_expiration_date]
    # Completing, an empty range leaves nothing to add: the day already holds every expiration listed.
    if not expirations_in_range and not completing:
        result.issues.append((None, f"{failed_request}; the symbol lists no expiration within {EXPIRATION_BY_EXPIRATION_MAX_DAYS_TO_EXPIRY} days to ask for on its own"))
    for expiration_date in expirations_in_range:
        try:
            result.rows.extend(fetch_part_rows(session, symbol, trading_date, day_part, expiration_date, expiration_by_expiration_retry_delays_seconds))
        except RequestFailed as error:
            result.issues.append((expiration_date.isoformat(), str(error)))
            logger.warning("%s: left out", error)
    # Each answer is free of repeats; a contract answered for two expirations would still break the day's write.
    result.rows = deduplicate_by_key(result.rows, day_part.key_length, day_part.name, trading_date)
    logger.warning("%s %s %s: %d rows from %d of %d expirations asked for one by one", day_part.name, symbol, trading_date.isoformat(), len(result.rows),
                   len(expirations_in_range) - len(result.issues), len(expirations_in_range))
    return result


@dataclasses.dataclass(frozen=True)
class DayIssue:
    """One day_issues row: a piece a stored day lacks. `expiry` is None for a whole part."""

    trading_date: datetime.date
    part_name: str
    expiry: datetime.date | None


def read_day_issues_to_retry(connection: sqlite3.Connection, days_in_range: list[datetime.date], day_plans: list[DayPlan]) -> list[DayIssue]:
    """The pieces asked for again on this run: every day_issues row in range that has not used up its
    RETRY_RUNS_PER_DAY_ISSUE later runs, of a day this run does not fetch (a fetched day's issues are rewritten)."""
    if not days_in_range:
        return []
    planned_date_texts = {day_plan.trading_date.isoformat() for day_plan in day_plans}
    rows = connection.execute(
        """SELECT i.trading_date, i.part, i.expiry FROM day_issues i JOIN days d ON d.trading_date = i.trading_date
           WHERE i.trading_date BETWEEN ? AND ? AND d.status = 'complete'
           GROUP BY i.trading_date, i.part, i.expiry HAVING max(i.attempts) <= ? ORDER BY i.trading_date, i.part, i.expiry""",
        (days_in_range[0].isoformat(), days_in_range[-1].isoformat(), RETRY_RUNS_PER_DAY_ISSUE)).fetchall()
    return [DayIssue(datetime.date.fromisoformat(trading_date_text), part_name, None if expiry_text is None else datetime.date.fromisoformat(expiry_text))
            for trading_date_text, part_name, expiry_text in rows if trading_date_text not in planned_date_texts]


def store_day_issue_retry(connection: sqlite3.Connection, day_issue: DayIssue, rows: list[tuple], failure: str | None, attempted_at_utc: datetime.datetime) -> str:
    """Records one retried piece in one transaction and returns what happened, for the log. Rows: stored, the day's
    counts brought up to date, the issue deleted. A failure, or a whole part still without data: one more attempt on the
    issue. One expiration that now answers with no data has nothing left to ask for: the issue is deleted."""
    trading_date_text = day_issue.trading_date.isoformat()
    issue_key = (trading_date_text, day_issue.part_name, None if day_issue.expiry is None else day_issue.expiry.isoformat())
    connection.execute("BEGIN IMMEDIATE")
    try:
        if failure is not None or (not rows and day_issue.expiry is None):
            connection.execute("UPDATE day_issues SET attempts = attempts + 1, message = ?, recorded_at = ? WHERE trading_date = ? AND part = ? AND expiry IS ?",
                               (failure or NO_DATA_RETURNED_MESSAGE, format_utc_timestamp(attempted_at_utc)) + issue_key)
            result = f"still left out ({failure})" if failure is not None else "still no data"
        else:
            if day_issue.part_name == INTRADAY_QUOTES_PART.name:
                stored_strike_window_pct = connection.execute("SELECT strike_window_pct FROM intraday_days WHERE trading_date = ?", (trading_date_text,)).fetchone()[0]
                rows, _ = keep_intraday_quotes_within_strike_window(connection, day_issue.trading_date, rows, stored_strike_window_pct)
            insert_part_rows(connection, day_issue.part_name, rows, replace_stored_rows=True)
            if day_issue.part_name == INTRADAY_QUOTES_PART.name:
                quote_rows, look_count = count_intraday_rows_and_looks(connection, trading_date_text)
                connection.execute("UPDATE intraday_days SET quote_rows = ?, look_count = ?, status = CASE WHEN ? > 0 THEN 'complete' ELSE status END WHERE trading_date = ?",
                                   (quote_rows, look_count, quote_rows, trading_date_text))
            else:
                connection.execute(f"UPDATE days SET {ROW_COUNT_COLUMN_BY_MORNING_PART_NAME[day_issue.part_name]} = ? WHERE trading_date = ?",
                                   (count_part_rows(connection, day_issue.part_name, trading_date_text), trading_date_text))
            connection.execute("DELETE FROM day_issues WHERE trading_date = ? AND part = ? AND expiry IS ?", issue_key)
            result = f"{len(rows)} rows stored" if rows else "no data for this expiration, nothing left to ask for"
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    return result


def retry_day_issues(session: ThetaDataSession, connection: sqlite3.Connection, symbol: str, day_issues: list[DayIssue], stop_requested: threading.Event,
                     retry_delays_seconds) -> None:
    """Asks once more for each piece earlier runs left out of a stored day, one request at a time. A request that fails
    again counts as an attempt only while ThetaData still answers for data already stored; otherwise the run ends
    (DownloadFailed) and the attempt is not counted."""
    references = read_stored_data_references(connection)
    for day_issue in day_issues:
        if stop_requested.is_set():
            raise DownloadCancelled()
        day_part = DAY_PART_BY_NAME[day_issue.part_name]
        rows, failure = [], None
        try:
            rows = fetch_part_rows(session, symbol, day_issue.trading_date, day_part, ALL_EXPIRATIONS if day_issue.expiry is None else day_issue.expiry, retry_delays_seconds)
        except RequestFailed as error:
            failure = str(error)
            confirm_service_still_answers(session, symbol, day_part, references, failure, retry_delays_seconds)
        if day_issue.expiry is not None:
            rows = [row for row in rows if row[day_part.key_length - 3] == day_issue.expiry.isoformat()]
        result = store_day_issue_retry(connection, day_issue, rows, failure, datetime.datetime.now(datetime.timezone.utc))
        (logger.warning if failure is not None else logger.info)(
            "%s %s %s %s asked for again: %s", symbol, day_issue.trading_date.isoformat(), day_part.label,
            "as a whole" if day_issue.expiry is None else f"expiration {day_issue.expiry.isoformat()}", result)


class GrpcStubWithDeadline:
    """Passes a deadline to every gRPC call the ThetaData client makes. The library sets none, so a stalled response
    stream would hold a request slot forever; DEADLINE_EXCEEDED is retried like any transient error."""

    def __init__(self, stub, deadline_seconds: float):
        self.stub = stub
        self.deadline_seconds = deadline_seconds

    def __getattr__(self, name):
        attribute = getattr(self.stub, name)
        if not callable(attribute):
            return attribute
        return functools.partial(attribute, timeout=self.deadline_seconds)


def create_thetadata_client(api_key: str, retry_delays_seconds=RETRY_DELAYS_SECONDS, sleep=time.sleep) -> ThetaClient:
    for attempt_index in range(len(retry_delays_seconds) + 1):
        try:
            client = ThetaClient(api_key=api_key, dotenv_path=API_ENV_FILE_PATH, dataframe_type="polars")
            client.stub = GrpcStubWithDeadline(client.stub, REQUEST_DEADLINE_SECONDS)
            return client
        except AuthenticationError as error:
            raise DownloadFailed(f"ThetaData authentication failed: {error}") from None
        except httpx.TransportError as error:
            if attempt_index == len(retry_delays_seconds):
                raise DownloadFailed(f"Could not reach ThetaData to authenticate: {error}") from None
            logger.warning("ThetaData authentication: %s, retrying in %s s", error, retry_delays_seconds[attempt_index])
            sleep(retry_delays_seconds[attempt_index])
    raise AssertionError("unreachable")


def load_symbol_expirations(session: ThetaDataSession, symbol: str, retry_delays_seconds=RETRY_DELAYS_SECONDS) -> list[datetime.date]:
    """Every expiration ThetaData lists for the symbol. None at all means a mistyped symbol, which would otherwise be
    stored as years of 'no_data' days that are never fetched again."""
    expirations = fetch_frame_with_retries(session, lambda client: client.option_list_expirations(symbol), f"expirations {symbol}", retry_delays_seconds)
    if expirations is None or expirations.height == 0:
        raise DownloadFailed(f"ThetaData has no options for symbol {symbol}")
    require_columns(expirations, ("expiration",), "expirations")
    return sorted({parse_expiry_date(value) for value in expirations["expiration"].to_list()})


# ---------------------------------------------------------------------------------------------------------------------
# Download loop


def wait_for_day_requests(futures: list[concurrent.futures.Future], stop_requested: threading.Event) -> None:
    """Waits until all of a day's requests finish. A request that failed raises its failure here, without waiting for
    the day's other requests (they may still be retrying); raises DownloadCancelled if a stop is requested first."""
    while True:
        if stop_requested.is_set():
            raise DownloadCancelled()
        _, not_done = concurrent.futures.wait(futures, timeout=STOP_CHECK_INTERVAL_SECONDS, return_when=concurrent.futures.FIRST_EXCEPTION)
        for future in futures:
            if future.done() and future.exception() is not None:
                raise future.exception()
        if not not_done:
            return


def parts_stored_without_rows(outcome: DayOutcome) -> list[str]:
    """The parts this run fetched for a complete day and stored no row of (ThetaData had no data for them, or every
    expiration failed)."""
    if outcome.status != "complete":
        return []
    rows_by_part = {"eod": outcome.end_of_day_rows, "open interest": outcome.open_interest_rows, "intraday quotes": outcome.intraday_quote_rows}
    if outcome.end_of_day_rows is not None:
        rows_by_part = {"quotes": outcome.quote_rows, **rows_by_part}
    return [part_label for part_label, row_count in rows_by_part.items() if row_count == 0]


def describe_day_outcome(outcome: DayOutcome) -> str:
    if outcome.unavailable_reason and outcome.status is None:
        return f"unavailable ({outcome.unavailable_reason})"
    counts = []
    if outcome.end_of_day_rows is not None:
        counts.append(f"{outcome.quote_rows} quotes, {outcome.end_of_day_rows} eod, {outcome.open_interest_rows} open interest")
    if outcome.intraday_quote_rows is not None:
        counts.append(f"{outcome.intraday_quote_rows} intraday quotes in {outcome.intraday_look_count} looks")
    if outcome.unavailable_reason:
        counts.append(f"intraday quotes unavailable ({outcome.unavailable_reason})")
    if outcome.added_rows_by_part_name:
        counts.append("completed to every expiry: " + ", ".join(f"+{added} {part_name.replace('_', ' ')}" for part_name, added in outcome.added_rows_by_part_name.items()))
    for failure in outcome.completion_failures:
        counts.append(f"not completed, asked for again on the next run ({failure})")
    if outcome.issue_count:
        counts.append(f"{outcome.issue_count} pieces left out")
    if parts_stored_without_rows(outcome):
        counts.append(f"stored with a missing part: {', '.join(parts_stored_without_rows(outcome))}")
    return f"{outcome.status}: {', '.join(counts)}" if counts else str(outcome.status)


def download_days(session: ThetaDataSession, connection: sqlite3.Connection, symbol: str, day_plans: list[DayPlan], days_total: int, days_done: int,
                  expiration_dates: list[datetime.date], strike_window_pct: float | None, emit_event, stop_requested: threading.Event,
                  no_data_is_final_through: datetime.date, retry_delays_seconds=RETRY_DELAYS_SECONDS,
                  expiration_by_expiration_retry_delays_seconds=EXPIRATION_BY_EXPIRATION_RETRY_DELAYS_SECONDS) -> int:
    """Fetches and stores each planned day in date order with at most MAX_REQUESTS_IN_FLIGHT requests running; returns days done."""
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_REQUESTS_IN_FLIGHT, thread_name_prefix="thetadata-request")
    references = read_stored_data_references(connection)
    days_waiting = collections.deque(day_plans)
    days_in_flight = collections.deque()
    previous_store_time = time.monotonic()
    first_store_time = None
    days_processed = 0
    # Per part without a stored reference: the days in a row it could not be retrieved at all.
    whole_part_failure_dates = collections.defaultdict(list)
    try:
        while days_waiting or days_in_flight:
            while days_waiting and len(days_in_flight) < DAYS_FETCHED_AHEAD:
                day_plan = days_waiting.popleft()
                morning = day_plan.fetch_morning_parts or day_plan.complete_morning_parts
                intraday = day_plan.fetch_intraday_quotes or day_plan.complete_intraday_quotes
                day_parts = (MORNING_PARTS if morning else ()) + ((INTRADAY_QUOTES_PART,) if intraday else ())
                futures_by_part_name = {
                    day_part.name: executor.submit(fetch_day_part, session, symbol, day_plan.trading_date, day_part, expiration_dates, references,
                                                   retry_delays_seconds, expiration_by_expiration_retry_delays_seconds,
                                                   day_plan.complete_intraday_quotes if day_part is INTRADAY_QUOTES_PART else day_plan.complete_morning_parts)
                    for day_part in day_parts
                }
                days_in_flight.append((day_plan, futures_by_part_name))
            day_plan, futures_by_part_name = days_in_flight.popleft()
            wait_for_day_requests(list(futures_by_part_name.values()), stop_requested)
            part_results = {part_name: future.result() for part_name, future in futures_by_part_name.items()}
            for part_name, part_result in part_results.items():
                if part_result.nothing_retrieved and references.get(part_name) is None:
                    whole_part_failure_dates[part_name].append(day_plan.trading_date)
                else:
                    whole_part_failure_dates[part_name].clear()
            outcome = store_day(connection, day_plan, part_results, strike_window_pct, datetime.datetime.now(datetime.timezone.utc), no_data_is_final_through)
            for part_name, expiry_text in outcome.reference_expiry_by_part_name.items():
                references.set([part_name], day_plan.trading_date, expiry_text)
            days_processed += 1
            store_time = time.monotonic()
            if first_store_time is None:
                first_store_time = store_time
            log_day = logger.warning if (outcome.unavailable_reason or outcome.issue_count or outcome.completion_failures or parts_stored_without_rows(outcome)) else logger.info
            log_day("%s %s %s (%.1f s)", symbol, day_plan.trading_date.isoformat(), describe_day_outcome(outcome), store_time - previous_store_time)
            previous_store_time = store_time
            if outcome.day_done:
                days_done += 1
                emit_event({"type": "progress", "daysDone": days_done, "daysTotal": days_total, "lastDate": day_plan.trading_date.isoformat(), "quoteRows": outcome.quote_rows})
            for part_name, failure_dates in whole_part_failure_dates.items():
                if len(failure_dates) >= WHOLE_PART_FAILURES_IN_A_ROW_THAT_STOP_THE_RUN:
                    raise DownloadFailed(
                        f"the {DAY_PART_BY_NAME[part_name].label} could not be retrieved at all on {len(failure_dates)} days in a row "
                        f"({failure_dates[0].isoformat()} to {failure_dates[-1].isoformat()}) and the file holds none yet to check ThetaData with: "
                        f"ThetaData may be having a problem with this request. Those days are recorded as unavailable and asked for again on the next run. "
                        f"Last failure: {part_results[part_name].issues[0][1]}")
            if stop_requested.is_set():
                raise DownloadCancelled()
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
        if days_processed > 1:
            logger.info("%s: %d days in %.1f s after the first (%.2f s per day)", symbol, days_processed, previous_store_time - first_store_time,
                        (previous_store_time - first_store_time) / (days_processed - 1))
    return days_done


# ---------------------------------------------------------------------------------------------------------------------
# Command line


class ArgumentParserReportingErrors(argparse.ArgumentParser):
    def error(self, message):
        raise DownloadFailed(f"invalid arguments: {message}")


def parse_arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = ArgumentParserReportingErrors(description="Download one symbol's ThetaData option history into <data-dir>/<SYMBOL>.sqlite.")
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--start", required=True, help="first trading date, YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="last trading date, YYYY-MM-DD (capped at the last finished session)")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--intraday-strike-window-pct", type=float, default=None,
                        help="keep intraday quotes only for strikes within this %% of the day's at-the-money strike (default: every strike)")
    return parser.parse_args(argv)


def parse_symbol(text: str) -> str:
    symbol = text.strip().upper()
    if not re.fullmatch(r"[A-Z][A-Z0-9.]{0,9}", symbol):
        raise DownloadFailed(f"invalid symbol: {text!r}")
    return symbol


def parse_date_argument(text: str, name: str) -> datetime.date:
    try:
        return datetime.date.fromisoformat(text)
    except ValueError:
        raise DownloadFailed(f"invalid --{name} date (expected YYYY-MM-DD): {text!r}") from None


def read_thetadata_api_key(env_file_path: Path) -> str:
    if not env_file_path.is_file():
        raise DownloadFailed(f"{env_file_path} not found (THETADATA_API_KEY is read from the API repo's .env)")
    api_key = (dotenv_values(env_file_path).get("THETADATA_API_KEY") or "").strip()
    if not api_key:
        raise DownloadFailed(f"THETADATA_API_KEY is not set in {env_file_path}")
    return api_key


def create_client_from_api_env_file():
    return create_thetadata_client(read_thetadata_api_key(API_ENV_FILE_PATH))


def redact_thetadata_api_key(message: str) -> str:
    try:
        api_key = (dotenv_values(API_ENV_FILE_PATH).get("THETADATA_API_KEY") or "").strip()
    except Exception:
        return message
    return message.replace(api_key, "[THETADATA_API_KEY]") if api_key else message


def run_download(argv: list[str] | None, emit_event, stop_requested: threading.Event, client_factory=create_client_from_api_env_file,
                 retry_delays_seconds=RETRY_DELAYS_SECONDS,
                 expiration_by_expiration_retry_delays_seconds=EXPIRATION_BY_EXPIRATION_RETRY_DELAYS_SECONDS,
                 waits_before_login_after_session_loss_seconds=WAITS_BEFORE_LOGIN_AFTER_SESSION_LOSS_SECONDS,
                 clock=lambda: datetime.datetime.now(datetime.timezone.utc)) -> int:
    """Runs one download and reports through emit_event; returns the process exit code."""
    connection = None
    symbol_file_path = None
    symbol_file_created_by_this_run = False
    try:
        arguments = parse_arguments(argv)
        symbol = parse_symbol(arguments.symbol)
        start_date = parse_date_argument(arguments.start, "start")
        end_date = parse_date_argument(arguments.end, "end")
        if end_date < start_date:
            raise DownloadFailed(f"--end {end_date.isoformat()} is before --start {start_date.isoformat()}")
        strike_window_pct = arguments.intraday_strike_window_pct
        if strike_window_pct is not None and not strike_window_pct > 0:
            raise DownloadFailed(f"--intraday-strike-window-pct must be above 0: {strike_window_pct}")
        data_directory = Path(arguments.data_dir).expanduser().resolve()
        data_directory.mkdir(parents=True, exist_ok=True)
        symbol_file_path = data_directory / f"{symbol}.sqlite"
        symbol_file_created_by_this_run = not symbol_file_path.exists()
        now_utc = clock()
        now_eastern = now_utc.astimezone(EASTERN_TIME_ZONE)
        connection = open_symbol_file(symbol_file_path, symbol, now_utc)
        days_in_range, day_plans = plan_days(start_date, end_date, now_eastern, read_stored_days(connection))
        no_data_is_final_through = now_eastern.date() - datetime.timedelta(days=NO_DATA_IS_FINAL_AFTER_CALENDAR_DAYS)
        day_issues_to_retry = read_day_issues_to_retry(connection, days_in_range, day_plans)
        days_total = len(days_in_range)
        days_done = days_total - len(day_plans)
        emit_event({"type": "start", "symbol": symbol, "daysTotal": days_total, "daysDone": days_done})
        if day_plans or day_issues_to_retry:
            session = ThetaDataSession(client_factory, stop_requested, waits_before_login_after_session_loss_seconds)
        if day_issues_to_retry:
            logger.info("%s: asking again for %d pieces earlier runs left out of stored days", symbol, len(day_issues_to_retry))
            retry_day_issues(session, connection, symbol, day_issues_to_retry, stop_requested, expiration_by_expiration_retry_delays_seconds)
        if day_plans:
            logger.info("%s: %d of %d days to fetch or complete (%s to %s; %d new, %d completed to every expiry, %d only for intraday quotes) into %s",
                        symbol, len(day_plans), days_total, day_plans[0].trading_date.isoformat(), day_plans[-1].trading_date.isoformat(),
                        sum(1 for day_plan in day_plans if day_plan.fetch_morning_parts),
                        sum(1 for day_plan in day_plans if day_plan.complete_morning_parts or day_plan.complete_intraday_quotes),
                        sum(1 for day_plan in day_plans if day_plan.fetch_intraday_quotes and not day_plan.fetch_morning_parts), symbol_file_path)
            expiration_dates = load_symbol_expirations(session, symbol, retry_delays_seconds)
            days_done = download_days(session, connection, symbol, day_plans, days_total, days_done, expiration_dates, strike_window_pct, emit_event,
                                      stop_requested, no_data_is_final_through, retry_delays_seconds, expiration_by_expiration_retry_delays_seconds)
        unavailable_days, days_with_issues = count_days_needing_attention(connection, days_in_range[0], days_in_range[-1]) if days_in_range else (0, 0)
        if unavailable_days or days_with_issues:
            logger.warning("%s: %d days unavailable (asked for again on the next run), %d days stored with something left out (asked for again on up to %d later runs)",
                           symbol, unavailable_days, days_with_issues, RETRY_RUNS_PER_DAY_ISSUE)
        emit_event({"type": "done", "daysDone": days_done, "daysTotal": days_total, "unavailableDays": unavailable_days, "daysWithIssues": days_with_issues})
        return 0
    except DownloadCancelled:
        logger.info("cancelled; every stored day is complete")
        emit_event({"type": "error", "message": "cancelled"})
        return 1
    except Exception as error:
        message = redact_thetadata_api_key(str(error) if isinstance(error, DownloadFailed) else f"{type(error).__name__}: {error}")
        if not isinstance(error, DownloadFailed):
            logger.error("unexpected failure: %s", message)
        emit_event({"type": "error", "message": message})
        return 1
    finally:
        if connection is not None:
            # A file this run created but recorded nothing in (mistyped symbol, refused request) is not left behind empty.
            remove_empty_symbol_file = symbol_file_created_by_this_run and connection.execute(
                "SELECT (SELECT count(*) FROM days) + (SELECT count(*) FROM unavailable_days)").fetchone()[0] == 0
            connection.close()
            if remove_empty_symbol_file:
                symbol_file_path.unlink(missing_ok=True)


def main() -> None:
    # Keep the real stdout for the JSON-lines protocol and send anything else written to stdout (by any library) to stderr.
    protocol_stream = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("thetadata").setLevel(logging.CRITICAL)
    logging.getLogger("httpx").setLevel(logging.WARNING)

    def emit_event(event: dict) -> None:
        protocol_stream.write(json.dumps(event, separators=(",", ":")) + "\n")
        protocol_stream.flush()

    stop_requested = threading.Event()
    signal.signal(signal.SIGTERM, lambda signal_number, frame: stop_requested.set())
    signal.signal(signal.SIGINT, lambda signal_number, frame: stop_requested.set())

    exit_code = run_download(sys.argv[1:], emit_event, stop_requested)
    protocol_stream.flush()
    sys.stderr.flush()
    # Requests still in flight after a failure or cancel are abandoned rather than awaited.
    os._exit(exit_code)


if __name__ == "__main__":
    main()
