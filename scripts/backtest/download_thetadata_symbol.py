# Downloads one symbol's option history from ThetaData into <data-dir>/<SYMBOL>.sqlite for the model backtest: for each
# weekday, every contract's NBBO at 10:00 ET (0..45 days to expiry), that day's end-of-day report and the open interest
# reported that morning (0..46 days). Resumable: days already in the file are skipped. At most 2 requests in flight
# (the plan's limit). Progress goes to stdout as JSON lines, logs to stderr. Spec: docs/backtesting/DATA-FILES.md.
#
# Run with the backtest venv: .venv-backtest/bin/python scripts/backtest/download_thetadata_symbol.py \
#   --symbol AAOI --start 2020-01-01 --end 2026-10-09 --data-dir /abs/path

import argparse
import collections
import concurrent.futures
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

SCHEMA_VERSION = "1"
QUOTE_TIME_EASTERN = "10:00:00"
QUOTE_MAX_DAYS_TO_EXPIRY = 45
END_OF_DAY_AND_OPEN_INTEREST_MAX_DAYS_TO_EXPIRY = 46
MAX_REQUESTS_IN_FLIGHT = 2
DAYS_FETCHED_AHEAD = 2
SESSION_FINISHED_HOUR_EASTERN = 18
EASTERN_TIME_ZONE = ZoneInfo("America/New_York")
API_REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
API_ENV_FILE_PATH = API_REPOSITORY_ROOT / ".env"
RETRY_DELAYS_SECONDS = (2, 5, 15, 30, 60)
REQUEST_DEADLINE_SECONDS = 600
SQLITE_BUSY_TIMEOUT_MILLISECONDS = 30_000
STOP_CHECK_INTERVAL_SECONDS = 0.5
STRIKE_DECIMALS = 3
PRICE_DECIMALS = 6

TRANSIENT_GRPC_STATUS_NAMES = {"UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "INTERNAL", "ABORTED", "UNKNOWN", "CANCELLED"}
REFUSED_GRPC_STATUS_NAMES = {"PERMISSION_DENIED", "UNAUTHENTICATED"}

SCHEMA_STATEMENTS = (
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS days (
  trading_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
  quote_rows INTEGER NOT NULL,
  eod_rows INTEGER NOT NULL,
  open_interest_rows INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS quotes (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  bid REAL, ask REAL, bid_size INTEGER, ask_size INTEGER,
  quoted_at TEXT,
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID""",
    """CREATE TABLE IF NOT EXISTS eod (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  close REAL, volume INTEGER, bid REAL, ask REAL,
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID""",
    """CREATE TABLE IF NOT EXISTS open_interest (
  trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  open_interest INTEGER NOT NULL,
  PRIMARY KEY (trading_date, expiry, strike, option_right)
) WITHOUT ROWID""",
)

logger = logging.getLogger("download_thetadata_symbol")


class DownloadFailed(Exception):
    """A failure the caller should see as the error line's message."""


class DownloadCancelled(Exception):
    """SIGTERM/SIGINT arrived; the day in progress was discarded or already committed."""


# ---------------------------------------------------------------------------------------------------------------------
# Dates and day planning


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


def plan_days(start_date: datetime.date, end_date: datetime.date, now_eastern: datetime.datetime, stored_trading_dates: set[str]) -> tuple[list[datetime.date], list[datetime.date]]:
    """Returns (weekdays in range up to the last finished session, those of them with no `days` row yet)."""
    last_date = min(end_date, last_finished_session_date(now_eastern))
    days_in_range = weekdays_between(start_date, last_date)
    days_to_fetch = [trading_date for trading_date in days_in_range if trading_date.isoformat() not in stored_trading_dates]
    return days_in_range, days_to_fetch


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
    raise DownloadFailed(f"ThetaData returned an unknown option right: {value!r}")


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
        raise DownloadFailed(f"ThetaData returned a quote timestamp without a time zone: {value!r}")
    return value.isoformat(timespec="milliseconds")


def require_columns(frame, column_names: tuple[str, ...], description: str) -> None:
    missing_columns = [column_name for column_name in column_names if column_name not in frame.columns]
    if missing_columns:
        raise DownloadFailed(f"ThetaData {description} response is missing columns {missing_columns} (has {list(frame.columns)})")


def contract_rows_within_days_to_expiry(frame, trading_date: datetime.date, max_days_to_expiry: int, column_names: tuple[str, ...], description: str):
    """Yields (expiry text, strike, right, named row) for contracts expiring 0..max_days_to_expiry days after trading_date."""
    if frame is None or frame.height == 0:
        return
    require_columns(frame, ("expiration", "strike", "right") + column_names, description)
    for row in frame.iter_rows(named=True):
        expiry_date = parse_expiry_date(row["expiration"])
        days_to_expiry = (expiry_date - trading_date).days
        if days_to_expiry < 0 or days_to_expiry > max_days_to_expiry:
            continue
        strike = price_or_none(row["strike"])
        if strike is None:
            logger.warning("%s %s: skipped a row without a strike", description, trading_date.isoformat())
            continue
        yield expiry_date.isoformat(), round(strike, STRIKE_DECIMALS), convert_option_right(row["right"]), row


def deduplicate_by_contract(rows: list[tuple], description: str, trading_date: datetime.date) -> list[tuple]:
    """Rows are (trading_date, expiry, strike, right, ...); keeps the last row per contract and warns about repeats."""
    rows_by_contract = {}
    for row in rows:
        rows_by_contract[row[1:4]] = row
    duplicate_count = len(rows) - len(rows_by_contract)
    if duplicate_count:
        logger.warning("%s %s: %d repeated contracts in the response, kept the last of each", description, trading_date.isoformat(), duplicate_count)
    return list(rows_by_contract.values())


def map_quote_rows(frame, trading_date: datetime.date) -> list[tuple]:
    """(trading_date, expiry, strike, right, bid, ask, bid_size, ask_size, quoted_at) for 0..45 days to expiry."""
    trading_date_text = trading_date.isoformat()
    rows = [
        (trading_date_text, expiry, strike, option_right, price_or_none(row["bid"]), price_or_none(row["ask"]),
         integer_or_none(row["bid_size"]), integer_or_none(row["ask_size"]), format_quote_timestamp(row["timestamp"]))
        for expiry, strike, option_right, row in contract_rows_within_days_to_expiry(
            frame, trading_date, QUOTE_MAX_DAYS_TO_EXPIRY, ("timestamp", "bid", "ask", "bid_size", "ask_size"), "quotes")
    ]
    return deduplicate_by_contract(rows, "quotes", trading_date)


def map_end_of_day_rows(frame, trading_date: datetime.date) -> list[tuple]:
    """(trading_date, expiry, strike, right, close, volume, bid, ask) for 0..46 days to expiry. ThetaData reports a
    close of 0 for a contract that did not trade that day (trade count 0); that is stored as no close (NULL)."""
    trading_date_text = trading_date.isoformat()
    rows = []
    for expiry, strike, option_right, row in contract_rows_within_days_to_expiry(
            frame, trading_date, END_OF_DAY_AND_OPEN_INTEREST_MAX_DAYS_TO_EXPIRY, ("close", "volume", "count", "bid", "ask"), "eod"):
        traded_that_day = (integer_or_none(row["count"]) or 0) > 0
        rows.append((trading_date_text, expiry, strike, option_right, price_or_none(row["close"]) if traded_that_day else None,
                     integer_or_none(row["volume"]), price_or_none(row["bid"]), price_or_none(row["ask"])))
    return deduplicate_by_contract(rows, "eod", trading_date)


def map_open_interest_rows(frame, trading_date: datetime.date) -> list[tuple]:
    """(trading_date, expiry, strike, right, open_interest) for 0..46 days to expiry."""
    trading_date_text = trading_date.isoformat()
    rows = []
    for expiry, strike, option_right, row in contract_rows_within_days_to_expiry(
            frame, trading_date, END_OF_DAY_AND_OPEN_INTEREST_MAX_DAYS_TO_EXPIRY, ("open_interest",), "open interest"):
        open_interest = integer_or_none(row["open_interest"])
        if open_interest is None:
            continue
        rows.append((trading_date_text, expiry, strike, option_right, open_interest))
    return deduplicate_by_contract(rows, "open interest", trading_date)


# ---------------------------------------------------------------------------------------------------------------------
# Symbol file


def open_symbol_file(file_path: Path, symbol: str, now_utc: datetime.datetime) -> sqlite3.Connection:
    """Opens (creating if needed) the symbol file with schema version 1 and checks its meta matches this download."""
    connection = sqlite3.connect(file_path, isolation_level=None)
    try:
        connection.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MILLISECONDS}")
        connection.execute("BEGIN IMMEDIATE")
        for statement in SCHEMA_STATEMENTS:
            connection.execute(statement)
        expected_meta = {
            "symbol": symbol,
            "schema_version": SCHEMA_VERSION,
            "quote_time_et": QUOTE_TIME_EASTERN,
            "max_dte": str(QUOTE_MAX_DAYS_TO_EXPIRY),
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


def read_stored_trading_dates(connection: sqlite3.Connection) -> set[str]:
    return {trading_date for (trading_date,) in connection.execute("SELECT trading_date FROM days")}


def write_day(connection: sqlite3.Connection, trading_date: datetime.date, quote_rows: list[tuple], end_of_day_rows: list[tuple],
              open_interest_rows: list[tuple], fetched_at_utc: datetime.datetime) -> str:
    """Writes one day's rows and its `days` row in one transaction; returns the status written."""
    trading_date_text = trading_date.isoformat()
    status = "complete" if (quote_rows or end_of_day_rows or open_interest_rows) else "no_data"
    connection.execute("BEGIN IMMEDIATE")
    try:
        for table_name in ("quotes", "eod", "open_interest"):
            connection.execute(f"DELETE FROM {table_name} WHERE trading_date = ?", (trading_date_text,))
        connection.executemany(
            "INSERT INTO quotes (trading_date, expiry, strike, option_right, bid, ask, bid_size, ask_size, quoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            quote_rows)
        connection.executemany(
            "INSERT INTO eod (trading_date, expiry, strike, option_right, close, volume, bid, ask) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            end_of_day_rows)
        connection.executemany(
            "INSERT INTO open_interest (trading_date, expiry, strike, option_right, open_interest) VALUES (?, ?, ?, ?, ?)",
            open_interest_rows)
        connection.execute(
            "INSERT INTO days (trading_date, status, quote_rows, eod_rows, open_interest_rows, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
            (trading_date_text, status, len(quote_rows), len(end_of_day_rows), len(open_interest_rows), format_utc_timestamp(fetched_at_utc)))
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    return status


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


def fetch_frame_with_retries(perform_request, description: str, retry_delays_seconds=RETRY_DELAYS_SECONDS, sleep=time.sleep):
    """Returns the request's frame, or None when ThetaData has no data. Transient gRPC errors are retried with backoff;
    a permission or authentication refusal fails at once."""
    for attempt_index in range(len(retry_delays_seconds) + 1):
        try:
            return perform_request()
        except NoDataFoundError:
            return None
        except grpc.RpcError as error:
            status_name = grpc_status_name(error)
            details = grpc_error_details(error)
            if status_name in REFUSED_GRPC_STATUS_NAMES:
                raise DownloadFailed(
                    f"ThetaData refused {description} ({status_name}: {details}). The API key or subscription does not "
                    f"allow this request (the options VALUE plan covers 2020-01-01 onwards).") from None
            if status_name not in TRANSIENT_GRPC_STATUS_NAMES or attempt_index == len(retry_delays_seconds):
                raise DownloadFailed(f"ThetaData request {description} failed ({status_name}: {details})") from None
            delay_seconds = retry_delays_seconds[attempt_index]
            logger.warning("%s: %s (%s), retrying in %s s", description, status_name, details, delay_seconds)
            sleep(delay_seconds)
    raise AssertionError("unreachable")


def request_quotes(client, symbol: str, trading_date: datetime.date):
    return client.option_at_time_quote(symbol, trading_date, trading_date, QUOTE_TIME_EASTERN, "*", max_dte=QUOTE_MAX_DAYS_TO_EXPIRY)


def request_end_of_day(client, symbol: str, trading_date: datetime.date):
    return client.option_history_eod(trading_date, trading_date, symbol, "*", max_dte=END_OF_DAY_AND_OPEN_INTEREST_MAX_DAYS_TO_EXPIRY)


def request_open_interest(client, symbol: str, trading_date: datetime.date):
    return client.option_history_open_interest(symbol, "*", date=trading_date, max_dte=END_OF_DAY_AND_OPEN_INTEREST_MAX_DAYS_TO_EXPIRY)


# (description, request, mapping) — the three requests made for every trading day, in the order they are queued.
DAY_REQUESTS = (
    ("quotes", request_quotes, map_quote_rows),
    ("eod", request_end_of_day, map_end_of_day_rows),
    ("open interest", request_open_interest, map_open_interest_rows),
)


def fetch_and_map_day_request(client, symbol: str, trading_date: datetime.date, day_request, retry_delays_seconds) -> list[tuple]:
    description, perform_request, map_rows = day_request
    frame = fetch_frame_with_retries(lambda: perform_request(client, symbol, trading_date),
                                     f"{description} {symbol} {trading_date.isoformat()}", retry_delays_seconds)
    return map_rows(frame, trading_date)


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


def confirm_symbol_has_options(client, symbol: str, retry_delays_seconds=RETRY_DELAYS_SECONDS) -> None:
    """A mistyped symbol would otherwise be stored as years of 'no_data' days that are never fetched again."""
    expirations = fetch_frame_with_retries(lambda: client.option_list_expirations(symbol), f"expirations {symbol}", retry_delays_seconds)
    if expirations is None or expirations.height == 0:
        raise DownloadFailed(f"ThetaData has no options for symbol {symbol}")


# ---------------------------------------------------------------------------------------------------------------------
# Download loop


def wait_for_day_requests(futures: list[concurrent.futures.Future], stop_requested: threading.Event) -> None:
    """Waits until all of a day's requests finish or one fails; raises DownloadCancelled if a stop is requested first."""
    while True:
        if stop_requested.is_set():
            raise DownloadCancelled()
        _, not_done = concurrent.futures.wait(futures, timeout=STOP_CHECK_INTERVAL_SECONDS, return_when=concurrent.futures.FIRST_EXCEPTION)
        if not not_done or any(future.done() and future.exception() is not None for future in futures):
            return


def download_days(client, connection: sqlite3.Connection, symbol: str, days_to_fetch: list[datetime.date], days_total: int, days_done: int,
                  emit_event, stop_requested: threading.Event, retry_delays_seconds=RETRY_DELAYS_SECONDS) -> int:
    """Fetches and commits each day in date order with at most MAX_REQUESTS_IN_FLIGHT requests running; returns days done."""
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_REQUESTS_IN_FLIGHT, thread_name_prefix="thetadata-request")
    days_waiting = collections.deque(days_to_fetch)
    days_in_flight = collections.deque()
    previous_commit_time = time.monotonic()
    first_commit_time = None
    days_committed = 0
    try:
        while days_waiting or days_in_flight:
            while days_waiting and len(days_in_flight) < DAYS_FETCHED_AHEAD:
                trading_date = days_waiting.popleft()
                futures = [executor.submit(fetch_and_map_day_request, client, symbol, trading_date, day_request, retry_delays_seconds)
                           for day_request in DAY_REQUESTS]
                days_in_flight.append((trading_date, futures))
            trading_date, futures = days_in_flight.popleft()
            wait_for_day_requests(futures, stop_requested)
            quote_rows, end_of_day_rows, open_interest_rows = [future.result() for future in futures]
            status = write_day(connection, trading_date, quote_rows, end_of_day_rows, open_interest_rows, datetime.datetime.now(datetime.timezone.utc))
            days_done += 1
            days_committed += 1
            commit_time = time.monotonic()
            if first_commit_time is None:
                first_commit_time = commit_time
            logger.info("%s %s %s: %d quotes, %d eod, %d open interest (%.1f s)", symbol, trading_date.isoformat(), status,
                        len(quote_rows), len(end_of_day_rows), len(open_interest_rows), commit_time - previous_commit_time)
            if status == "complete" and not (quote_rows and end_of_day_rows and open_interest_rows):
                logger.warning("%s %s stored with a missing part: %d quotes, %d eod, %d open interest", symbol, trading_date.isoformat(),
                               len(quote_rows), len(end_of_day_rows), len(open_interest_rows))
            previous_commit_time = commit_time
            emit_event({"type": "progress", "daysDone": days_done, "daysTotal": days_total, "lastDate": trading_date.isoformat(), "quoteRows": len(quote_rows)})
            if stop_requested.is_set():
                raise DownloadCancelled()
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
        if days_committed > 1:
            logger.info("%s: %d days in %.1f s after the first (%.2f s per day)", symbol, days_committed, previous_commit_time - first_commit_time,
                        (previous_commit_time - first_commit_time) / (days_committed - 1))
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
                 retry_delays_seconds=RETRY_DELAYS_SECONDS) -> int:
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
        data_directory = Path(arguments.data_dir).expanduser().resolve()
        data_directory.mkdir(parents=True, exist_ok=True)
        symbol_file_path = data_directory / f"{symbol}.sqlite"
        symbol_file_created_by_this_run = not symbol_file_path.exists()
        connection = open_symbol_file(symbol_file_path, symbol, datetime.datetime.now(datetime.timezone.utc))
        days_in_range, days_to_fetch = plan_days(start_date, end_date, datetime.datetime.now(EASTERN_TIME_ZONE), read_stored_trading_dates(connection))
        days_total = len(days_in_range)
        days_done = days_total - len(days_to_fetch)
        emit_event({"type": "start", "symbol": symbol, "daysTotal": days_total, "daysDone": days_done})
        if days_to_fetch:
            logger.info("%s: fetching %d of %d days (%s to %s) into %s", symbol, len(days_to_fetch), days_total,
                        days_to_fetch[0].isoformat(), days_to_fetch[-1].isoformat(), symbol_file_path)
            client = client_factory()
            confirm_symbol_has_options(client, symbol, retry_delays_seconds)
            days_done = download_days(client, connection, symbol, days_to_fetch, days_total, days_done, emit_event, stop_requested, retry_delays_seconds)
        emit_event({"type": "done", "daysDone": days_done, "daysTotal": days_total})
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
            # A file this run created but stored no day in (mistyped symbol, refused request) is not left behind empty.
            remove_empty_symbol_file = symbol_file_created_by_this_run and connection.execute("SELECT count(*) FROM days").fetchone()[0] == 0
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
