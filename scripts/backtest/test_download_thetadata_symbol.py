# Unit tests for the ThetaData downloader's pure parts and its download loop, with a fake client (no network).
# Run from the API repo root: .venv-backtest/bin/python -m unittest scripts/backtest/test_download_thetadata_symbol.py

import datetime
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo

import grpc
import polars as pl
from thetadata.errors import NoDataFoundError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import download_thetadata_symbol as downloader  # noqa: E402

EASTERN = ZoneInfo("America/New_York")
NO_RETRY_DELAYS = (0, 0, 0)


def eastern_time(year, month, day, hour, minute=0):
    return datetime.datetime(year, month, day, hour, minute, tzinfo=EASTERN)


def quote_frame(trading_date, contracts):
    """contracts: (expiry text, strike, right word, bid, ask)."""
    quoted_at = datetime.datetime.combine(trading_date, datetime.time(9, 59, 58, 207000), tzinfo=EASTERN)
    return pl.DataFrame({
        "symbol": ["INTC"] * len(contracts),
        "expiration": [contract[0] for contract in contracts],
        "strike": [contract[1] for contract in contracts],
        "right": [contract[2] for contract in contracts],
        "timestamp": [quoted_at] * len(contracts),
        "bid_size": [11] * len(contracts), "bid_exchange": [5] * len(contracts),
        "bid": [contract[3] for contract in contracts], "bid_condition": [50] * len(contracts),
        "ask_size": [6] * len(contracts), "ask_exchange": [43] * len(contracts),
        "ask": [contract[4] for contract in contracts], "ask_condition": [50] * len(contracts),
    }, schema_overrides={"timestamp": pl.Datetime("ms", "America/New_York")})


def end_of_day_frame(trading_date, contracts):
    """contracts: (expiry text, strike, right word, close, volume, trade count, bid, ask)."""
    created = datetime.datetime.combine(trading_date, datetime.time(17, 16, 48), tzinfo=EASTERN)
    return pl.DataFrame({
        "symbol": ["INTC"] * len(contracts),
        "expiration": [contract[0] for contract in contracts],
        "strike": [contract[1] for contract in contracts],
        "right": [contract[2] for contract in contracts],
        "created": [created] * len(contracts), "last_trade": [created] * len(contracts),
        "open": [contract[3] for contract in contracts], "high": [contract[3] for contract in contracts],
        "low": [contract[3] for contract in contracts], "close": [contract[3] for contract in contracts],
        "volume": [contract[4] for contract in contracts], "count": [contract[5] for contract in contracts],
        "bid_size": [1] * len(contracts), "bid_exchange": [1] * len(contracts),
        "bid": [contract[6] for contract in contracts], "bid_condition": [50] * len(contracts),
        "ask_size": [1] * len(contracts), "ask_exchange": [1] * len(contracts),
        "ask": [contract[7] for contract in contracts], "ask_condition": [50] * len(contracts),
    }, schema_overrides={"created": pl.Datetime("ms", "America/New_York"), "last_trade": pl.Datetime("ms", "America/New_York")})


def open_interest_frame(trading_date, contracts):
    """contracts: (expiry text, strike, right word, open interest)."""
    reported = datetime.datetime.combine(trading_date, datetime.time(6, 30, 24), tzinfo=EASTERN)
    return pl.DataFrame({
        "symbol": ["INTC"] * len(contracts),
        "expiration": [contract[0] for contract in contracts],
        "strike": [contract[1] for contract in contracts],
        "right": [contract[2] for contract in contracts],
        "timestamp": [reported] * len(contracts),
        "open_interest": [contract[3] for contract in contracts],
    }, schema_overrides={"timestamp": pl.Datetime("ms", "America/New_York"), "open_interest": pl.Int64})


def frames_for_trading_day(trading_date):
    expiry = (trading_date + datetime.timedelta(days=4)).isoformat()
    return {
        "quotes": quote_frame(trading_date, [(expiry, 42.5, "CALL", 0.5, 0.55), (expiry, 42.5, "PUT", 1.1, 1.15), (expiry, 45.0, "CALL", 0.1, 0.12)]),
        "eod": end_of_day_frame(trading_date, [(expiry, 42.5, "CALL", 0.52, 120, 14, 0.5, 0.54), (expiry, 42.5, "PUT", 0.0, 0, 0, 1.0, 1.1)]),
        "open interest": open_interest_frame(trading_date, [(expiry, 42.5, "CALL", 300), (expiry, 42.5, "PUT", 210), (expiry, 45.0, "CALL", 90), (expiry, 47.0, "CALL", 15)]),
    }


class FakeRpcError(grpc.RpcError):
    def __init__(self, status_code, status_details):
        super().__init__(status_details)
        self.status_code = status_code
        self.status_details = status_details

    def code(self):
        return self.status_code

    def details(self):
        return self.status_details


class FakeThetaClient:
    """Answers the downloader's requests from in-memory frames; a date missing from frames_by_date has no data (holiday)."""

    def __init__(self, frames_by_date, failures=None, call_duration_seconds=0.005, on_request=None, has_options=True):
        self.frames_by_date = frames_by_date
        self.failures = {key: list(errors) for key, errors in (failures or {}).items()}
        self.call_duration_seconds = call_duration_seconds
        self.on_request = on_request
        self.has_options = has_options
        self.lock = threading.Lock()
        self.calls = []
        self.requests_in_flight = 0
        self.max_requests_in_flight = 0

    def respond(self, request_kind, trading_date):
        with self.lock:
            self.calls.append((request_kind, trading_date))
            self.requests_in_flight += 1
            self.max_requests_in_flight = max(self.max_requests_in_flight, self.requests_in_flight)
        try:
            if self.on_request is not None:
                self.on_request(request_kind, trading_date)
            time.sleep(self.call_duration_seconds)
            with self.lock:
                pending_errors = self.failures.get((request_kind, trading_date))
                error = pending_errors.pop(0) if pending_errors else None
            if error is not None:
                raise error
            frame = self.frames_by_date.get(trading_date, {}).get(request_kind)
            if frame is None:
                raise NoDataFoundError(f"No data found for: {request_kind} {trading_date}")
            return frame
        finally:
            with self.lock:
                self.requests_in_flight -= 1

    def option_at_time_quote(self, symbol, start_date, end_date, time_of_day, expiration, max_dte=None):
        assert start_date == end_date and time_of_day == "10:00:00" and expiration == "*" and max_dte == 45
        return self.respond("quotes", start_date)

    def option_history_eod(self, start_date, end_date, symbol, expiration, max_dte=None):
        assert start_date == end_date and expiration == "*" and max_dte == 46
        return self.respond("eod", start_date)

    def option_history_open_interest(self, symbol, expiration, date=None, max_dte=None):
        assert expiration == "*" and max_dte == 46
        return self.respond("open interest", date)

    def option_list_expirations(self, symbol):
        if not self.has_options:
            raise NoDataFoundError(f"No data found for: option_list_expirations({symbol})")
        return pl.DataFrame({"symbol": [symbol], "expiration": ["2024-04-05"]})


class GrpcStubWithDeadlineTests(unittest.TestCase):
    def test_every_call_gets_the_deadline(self):
        class RecordingStub:
            channel_name = "mdds"

            def __init__(self):
                self.calls = []

            def GetOptionAtTimeQuote(self, request, **keyword_arguments):
                self.calls.append((request, keyword_arguments))
                return iter(())

        recording_stub = RecordingStub()
        stub_with_deadline = downloader.GrpcStubWithDeadline(recording_stub, 300)
        stub_with_deadline.GetOptionAtTimeQuote("request")
        self.assertEqual(recording_stub.calls, [("request", {"timeout": 300})])
        self.assertEqual(stub_with_deadline.channel_name, "mdds")

    def test_deadline_exceeded_is_retried(self):
        attempts = []

        def perform_request():
            attempts.append(1)
            if len(attempts) == 1:
                raise FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED, "Deadline Exceeded")
            return "frame"

        self.assertEqual(downloader.fetch_frame_with_retries(perform_request, "quotes INTC 2024-06-21", NO_RETRY_DELAYS), "frame")
        self.assertEqual(len(attempts), 2)


class DayPlanningTests(unittest.TestCase):
    def test_a_weekday_counts_only_from_18_eastern(self):
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 26, 17, 59)), datetime.date(2024, 3, 25))
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 26, 18, 0)), datetime.date(2024, 3, 26))

    def test_monday_before_18_and_weekends_fall_back_to_friday(self):
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 25, 10, 0)), datetime.date(2024, 3, 22))
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 23, 20, 0)), datetime.date(2024, 3, 22))
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 24, 23, 0)), datetime.date(2024, 3, 22))

    def test_plan_skips_weekends_stored_days_and_the_unfinished_session(self):
        days_in_range, days_to_fetch = downloader.plan_days(
            datetime.date(2024, 3, 21), datetime.date(2024, 3, 29), eastern_time(2024, 3, 27, 12, 0), {"2024-03-22", "2024-01-02"})
        self.assertEqual(days_in_range, [datetime.date(2024, 3, 21), datetime.date(2024, 3, 22), datetime.date(2024, 3, 25), datetime.date(2024, 3, 26)])
        self.assertEqual(days_to_fetch, [datetime.date(2024, 3, 21), datetime.date(2024, 3, 25), datetime.date(2024, 3, 26)])

    def test_plan_is_empty_when_the_range_starts_after_the_last_session(self):
        self.assertEqual(downloader.plan_days(datetime.date(2024, 3, 26), datetime.date(2024, 3, 29), eastern_time(2024, 3, 26, 9, 0), set()), ([], []))


class RowMappingTests(unittest.TestCase):
    trading_date = datetime.date(2024, 3, 25)

    def test_quotes_map_rights_strikes_timestamps_and_keep_0_to_45_days(self):
        frame = quote_frame(self.trading_date, [
            ("2024-03-25", 42.5, "CALL", 0.5, 0.55),          # 0 days: kept
            ("2024-05-09", 40.0, "PUT", 13.950000000000001, 14.1),  # 45 days: kept, float noise rounded
            ("2024-05-10", 40.0, "PUT", 1.0, 1.1),            # 46 days: dropped
            ("2024-03-22", 40.0, "CALL", 0.0, 0.01),          # expired: dropped
            ("2024-04-05", 41.0, "PUT", float("nan"), 0.2),   # no bid price: NULL
        ])
        rows = downloader.map_quote_rows(frame, self.trading_date)
        self.assertEqual(rows, [
            ("2024-03-25", "2024-03-25", 42.5, "C", 0.5, 0.55, 11, 6, "2024-03-25T09:59:58.207-04:00"),
            ("2024-03-25", "2024-05-09", 40.0, "P", 13.95, 14.1, 11, 6, "2024-03-25T09:59:58.207-04:00"),
            ("2024-03-25", "2024-04-05", 41.0, "P", None, 0.2, 11, 6, "2024-03-25T09:59:58.207-04:00"),
        ])

    def test_end_of_day_keeps_46_days_and_stores_no_close_when_nothing_traded(self):
        frame = end_of_day_frame(self.trading_date, [
            ("2024-05-10", 40.0, "CALL", 0.31, 25, 4, 0.3, 0.33),  # 46 days: kept
            ("2024-05-11", 40.0, "CALL", 0.31, 25, 4, 0.3, 0.33),  # 47 days: dropped
            ("2024-04-05", 54.0, "PUT", 0.0, 0, 0, 10.65, 12.35),  # no trades: close NULL, volume 0
        ])
        self.assertEqual(downloader.map_end_of_day_rows(frame, self.trading_date), [
            ("2024-03-25", "2024-05-10", 40.0, "C", 0.31, 25, 0.3, 0.33),
            ("2024-03-25", "2024-04-05", 54.0, "P", None, 0, 10.65, 12.35),
        ])

    def test_open_interest_drops_expired_contracts_and_missing_values(self):
        frame = open_interest_frame(self.trading_date, [
            ("2024-03-22", 50.0, "CALL", 3260),  # expired last Friday, still in Monday's report: dropped
            ("2024-04-05", 54.0, "CALL", 86),
            ("2024-04-05", 55.0, "CALL", None),
        ])
        self.assertEqual(downloader.map_open_interest_rows(frame, self.trading_date), [("2024-03-25", "2024-04-05", 54.0, "C", 86)])

    def test_repeated_contracts_keep_the_last_row(self):
        frame = open_interest_frame(self.trading_date, [("2024-04-05", 54.0, "CALL", 86), ("2024-04-05", 54.0, "CALL", 90)])
        self.assertEqual(downloader.map_open_interest_rows(frame, self.trading_date), [("2024-03-25", "2024-04-05", 54.0, "C", 90)])

    def test_no_frame_maps_to_no_rows(self):
        self.assertEqual(downloader.map_quote_rows(None, self.trading_date), [])

    def test_a_missing_column_fails_clearly(self):
        frame = open_interest_frame(self.trading_date, [("2024-04-05", 54.0, "CALL", 86)]).drop("open_interest")
        with self.assertRaisesRegex(downloader.DownloadFailed, "missing columns \\['open_interest'\\]"):
            downloader.map_open_interest_rows(frame, self.trading_date)

    def test_an_unknown_right_fails_clearly(self):
        frame = open_interest_frame(self.trading_date, [("2024-04-05", 54.0, "STRADDLE", 86)])
        with self.assertRaisesRegex(downloader.DownloadFailed, "unknown option right"):
            downloader.map_open_interest_rows(frame, self.trading_date)


class SymbolFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.file_path = Path(self.temporary_directory.name) / "INTC.sqlite"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_creates_schema_version_1(self):
        created_at = datetime.datetime(2026, 10, 12, 3, 4, 5, 678000, tzinfo=datetime.timezone.utc)
        connection = downloader.open_symbol_file(self.file_path, "INTC", created_at)
        try:
            self.assertEqual(dict(connection.execute("SELECT key, value FROM meta")), {
                "symbol": "INTC", "schema_version": "1", "quote_time_et": "10:00:00", "max_dte": "45", "created_at": "2026-10-12T03:04:05.678Z"})
            columns_by_table = {table_name: [column[1] for column in connection.execute(f"PRAGMA table_info({table_name})")]
                                for table_name in ("days", "quotes", "eod", "open_interest")}
            self.assertEqual(columns_by_table, {
                "days": ["trading_date", "status", "quote_rows", "eod_rows", "open_interest_rows", "fetched_at"],
                "quotes": ["trading_date", "expiry", "strike", "option_right", "bid", "ask", "bid_size", "ask_size", "quoted_at"],
                "eod": ["trading_date", "expiry", "strike", "option_right", "close", "volume", "bid", "ask"],
                "open_interest": ["trading_date", "expiry", "strike", "option_right", "open_interest"],
            })
            without_rowid_tables = {name for name, sql in connection.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'") if "WITHOUT ROWID" in sql}
            self.assertEqual(without_rowid_tables, {"quotes", "eod", "open_interest"})
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("INSERT INTO days VALUES ('2024-03-25', 'partial', 0, 0, 0, 'x')")
        finally:
            connection.close()

    def test_reopening_keeps_created_at_and_rejects_another_symbol(self):
        downloader.open_symbol_file(self.file_path, "INTC", datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)).close()
        connection = downloader.open_symbol_file(self.file_path, "INTC", datetime.datetime(2026, 2, 2, tzinfo=datetime.timezone.utc))
        self.assertEqual(connection.execute("SELECT value FROM meta WHERE key = 'created_at'").fetchone()[0], "2026-01-01T00:00:00.000Z")
        connection.close()
        with self.assertRaisesRegex(downloader.DownloadFailed, "symbol='INTC'"):
            downloader.open_symbol_file(self.file_path, "SMCI", datetime.datetime(2026, 2, 2, tzinfo=datetime.timezone.utc))

    def test_a_failing_day_write_leaves_nothing_behind(self):
        connection = downloader.open_symbol_file(self.file_path, "INTC", datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
        try:
            repeated_quote = ("2024-03-25", "2024-04-05", 42.5, "C", 0.5, 0.55, 1, 1, None)
            with self.assertRaises(sqlite3.IntegrityError):
                downloader.write_day(connection, datetime.date(2024, 3, 25), [repeated_quote, repeated_quote], [], [], datetime.datetime.now(datetime.timezone.utc))
            self.assertEqual(connection.execute("SELECT (SELECT count(*) FROM quotes) + (SELECT count(*) FROM days)").fetchone()[0], 0)
            self.assertFalse(connection.in_transaction)
        finally:
            connection.close()

    def test_rewriting_a_day_whose_days_row_was_deleted_replaces_its_rows(self):
        connection = downloader.open_symbol_file(self.file_path, "INTC", datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
        try:
            trading_date = datetime.date(2024, 3, 25)
            quote = ("2024-03-25", "2024-04-05", 42.5, "C", 0.5, 0.55, 1, 1, None)
            downloader.write_day(connection, trading_date, [quote], [], [], datetime.datetime.now(datetime.timezone.utc))
            connection.execute("DELETE FROM days WHERE trading_date = '2024-03-25'")
            downloader.write_day(connection, trading_date, [quote[:4] + (0.6, 0.65, 1, 1, None)], [], [], datetime.datetime.now(datetime.timezone.utc))
            self.assertEqual(connection.execute("SELECT bid FROM quotes").fetchall(), [(0.6,)])
        finally:
            connection.close()


class DownloadRunTests(unittest.TestCase):
    """run_download end to end with a fake client: 2024-03-25..29, Good Friday 29 March has no data."""

    trading_dates = [datetime.date(2024, 3, 25), datetime.date(2024, 3, 26), datetime.date(2024, 3, 27), datetime.date(2024, 3, 28)]
    holiday = datetime.date(2024, 3, 29)

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.data_directory = Path(self.temporary_directory.name) / "backtest-data"
        self.frames_by_date = {trading_date: frames_for_trading_day(trading_date) for trading_date in self.trading_dates}

    def tearDown(self):
        self.temporary_directory.cleanup()

    def run_downloader(self, client, stop_requested=None, start="2024-03-25", end="2024-03-29", client_factory_calls=None):
        events = []

        def client_factory():
            if client_factory_calls is not None:
                client_factory_calls.append(1)
            return client

        exit_code = downloader.run_download(["--symbol", "intc", "--start", start, "--end", end, "--data-dir", str(self.data_directory)],
                                            events.append, stop_requested or threading.Event(), client_factory, NO_RETRY_DELAYS)
        return exit_code, events

    def read_database(self, query):
        connection = sqlite3.connect(self.data_directory / "INTC.sqlite")
        try:
            return connection.execute(query).fetchall()
        finally:
            connection.close()

    def assert_every_stored_day_is_whole(self):
        mismatches = self.read_database("""
            SELECT d.trading_date FROM days d
            WHERE d.quote_rows != (SELECT count(*) FROM quotes q WHERE q.trading_date = d.trading_date)
               OR d.eod_rows != (SELECT count(*) FROM eod e WHERE e.trading_date = d.trading_date)
               OR d.open_interest_rows != (SELECT count(*) FROM open_interest o WHERE o.trading_date = d.trading_date)""")
        self.assertEqual(mismatches, [])
        orphan_dates = self.read_database("""
            SELECT trading_date FROM (SELECT trading_date FROM quotes UNION SELECT trading_date FROM eod UNION SELECT trading_date FROM open_interest)
            WHERE trading_date NOT IN (SELECT trading_date FROM days)""")
        self.assertEqual(orphan_dates, [])

    def test_downloads_every_day_stores_the_holiday_as_no_data_and_resumes_with_nothing_to_fetch(self):
        client = FakeThetaClient(self.frames_by_date)
        exit_code, events = self.run_downloader(client)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[0], {"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 0})
        self.assertEqual([event["lastDate"] for event in events[1:-1]], ["2024-03-25", "2024-03-26", "2024-03-27", "2024-03-28", "2024-03-29"])
        self.assertEqual(events[1], {"type": "progress", "daysDone": 1, "daysTotal": 5, "lastDate": "2024-03-25", "quoteRows": 3})
        self.assertEqual(events[-1], {"type": "done", "daysDone": 5, "daysTotal": 5})
        self.assertEqual(self.read_database("SELECT trading_date, status, quote_rows, eod_rows, open_interest_rows FROM days ORDER BY trading_date"), [
            ("2024-03-25", "complete", 3, 2, 4), ("2024-03-26", "complete", 3, 2, 4), ("2024-03-27", "complete", 3, 2, 4),
            ("2024-03-28", "complete", 3, 2, 4), ("2024-03-29", "no_data", 0, 0, 0)])
        self.assertEqual(self.read_database("SELECT * FROM eod WHERE trading_date = '2024-03-25' ORDER BY option_right"), [
            ("2024-03-25", "2024-03-29", 42.5, "C", 0.52, 120, 0.5, 0.54), ("2024-03-25", "2024-03-29", 42.5, "P", None, 0, 1.0, 1.1)])
        self.assert_every_stored_day_is_whole()
        self.assertEqual(client.max_requests_in_flight, 2)

        resumed_client = FakeThetaClient(self.frames_by_date)
        client_factory_calls = []
        exit_code, events = self.run_downloader(resumed_client, client_factory_calls=client_factory_calls)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events, [{"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 5}, {"type": "done", "daysDone": 5, "daysTotal": 5}])
        self.assertEqual((resumed_client.calls, client_factory_calls), ([], []))

    def test_a_longer_range_after_a_partial_download_fetches_only_the_new_days(self):
        self.run_downloader(FakeThetaClient(self.frames_by_date), end="2024-03-26")
        client = FakeThetaClient(self.frames_by_date)
        exit_code, events = self.run_downloader(client)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[0], {"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 2})
        self.assertEqual(sorted({trading_date for _, trading_date in client.calls}), [datetime.date(2024, 3, 27), datetime.date(2024, 3, 28), self.holiday])

    def test_never_more_than_two_requests_in_flight(self):
        client = FakeThetaClient(self.frames_by_date, call_duration_seconds=0.03)
        self.run_downloader(client)
        self.assertEqual(len(client.calls), 15)
        self.assertEqual(client.max_requests_in_flight, 2)

    def test_a_transient_error_is_retried(self):
        client = FakeThetaClient(self.frames_by_date, failures={("quotes", self.trading_dates[0]): [FakeRpcError(grpc.StatusCode.UNAVAILABLE, "connection reset")]})
        exit_code, events = self.run_downloader(client)
        self.assertEqual((exit_code, events[-1]["type"]), (0, "done"))
        self.assertEqual(client.calls.count(("quotes", self.trading_dates[0])), 2)

    def test_retries_give_up_with_an_error(self):
        unavailable = [FakeRpcError(grpc.StatusCode.UNAVAILABLE, "down")] * (len(NO_RETRY_DELAYS) + 1)
        client = FakeThetaClient(self.frames_by_date, failures={("eod", self.trading_dates[1]): unavailable})
        exit_code, events = self.run_downloader(client)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("UNAVAILABLE", events[-1]["message"])
        self.assertEqual(client.calls.count(("eod", self.trading_dates[1])), len(NO_RETRY_DELAYS) + 1)

    def test_a_permission_error_fails_at_once_and_keeps_only_whole_days(self):
        client = FakeThetaClient(self.frames_by_date, failures={("eod", self.trading_dates[1]): [FakeRpcError(grpc.StatusCode.PERMISSION_DENIED, "not subscribed")]})
        exit_code, events = self.run_downloader(client)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("PERMISSION_DENIED", events[-1]["message"])
        self.assertEqual(client.calls.count(("eod", self.trading_dates[1])), 1)
        self.assertEqual(self.read_database("SELECT trading_date FROM days"), [("2024-03-25",)])
        self.assert_every_stored_day_is_whole()

    def test_a_stop_request_ends_with_cancelled_and_no_half_written_day(self):
        stop_requested = threading.Event()

        def stop_on_third_day(request_kind, trading_date):
            if trading_date == self.trading_dates[2] and request_kind == "eod":
                stop_requested.set()

        client = FakeThetaClient(self.frames_by_date, on_request=stop_on_third_day, call_duration_seconds=0.02)
        exit_code, events = self.run_downloader(client, stop_requested=stop_requested)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1], {"type": "error", "message": "cancelled"})
        stored_dates = [trading_date for (trading_date,) in self.read_database("SELECT trading_date FROM days ORDER BY trading_date")]
        self.assertLess(len(stored_dates), 5)
        self.assertEqual(stored_dates, ["2024-03-25", "2024-03-26", "2024-03-27"][:len(stored_dates)])
        self.assert_every_stored_day_is_whole()

    def test_a_symbol_without_options_fails_and_leaves_no_empty_file(self):
        exit_code, events = self.run_downloader(FakeThetaClient(self.frames_by_date, has_options=False))
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1], {"type": "error", "message": "ThetaData has no options for symbol INTC"})
        self.assertFalse((self.data_directory / "INTC.sqlite").exists())

    def test_a_failure_keeps_an_existing_file(self):
        self.run_downloader(FakeThetaClient(self.frames_by_date), end="2024-03-25")
        refused = [FakeRpcError(grpc.StatusCode.PERMISSION_DENIED, "not subscribed")]
        exit_code, _ = self.run_downloader(FakeThetaClient(self.frames_by_date, failures={("quotes", self.trading_dates[1]): refused}))
        self.assertEqual(exit_code, 1)
        self.assertEqual(self.read_database("SELECT trading_date FROM days"), [("2024-03-25",)])

    def test_invalid_arguments_are_reported_as_an_error_line(self):
        events = []
        exit_code = downloader.run_download(["--symbol", "INTC", "--start", "2024-03-29", "--end", "2024-03-25", "--data-dir", str(self.data_directory)],
                                            events.append, threading.Event(), lambda: None, NO_RETRY_DELAYS)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events, [{"type": "error", "message": "--end 2024-03-25 is before --start 2024-03-29"}])
        exit_code = downloader.run_download(["--symbol", "INTC"], events.append, threading.Event(), lambda: None, NO_RETRY_DELAYS)
        self.assertEqual(exit_code, 1)
        self.assertTrue(events[-1]["message"].startswith("invalid arguments:"))


if __name__ == "__main__":
    unittest.main()
