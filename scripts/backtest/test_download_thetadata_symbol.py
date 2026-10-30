# Unit tests for the ThetaData downloader: planning, row mapping, the symbol file, and whole runs against an in-memory
# ThetaData (no network, no login). Run from the API repo root:
#   .venv-backtest/bin/python -m unittest scripts/backtest/test_download_thetadata_symbol.py

import concurrent.futures
import datetime
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path
from zoneinfo import ZoneInfo

import grpc
import polars as pl
from thetadata import ThetaClient
from thetadata._proto.endpoints_pb2 import AuthToken
from thetadata.errors import NoDataFoundError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import download_thetadata_symbol as downloader  # noqa: E402

EASTERN = ZoneInfo("America/New_York")
NO_RETRY_DELAYS = (0, 0, 0)
NO_EXPIRATION_BY_EXPIRATION_RETRY_DELAYS = (0,)
NO_WAITS_BEFORE_LOGIN = (0, 0, 0, 0, 0)
SESSION_TAKEN_DETAILS = "Invalid session ID. This can occur if more than one terminal is running. If restarting your terminal does not resolve the issue, please contact support."


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


def intraday_quote_frame(trading_date, contracts, look_times=downloader.INTRADAY_LOOK_TIMES):
    """One row per contract and look, stamped with the look time as ThetaData does. contracts: (expiry text, strike, right word, bid, ask)."""
    rows = [(contract, datetime.datetime.combine(trading_date, datetime.time.fromisoformat(look_time), tzinfo=EASTERN))
            for look_time in look_times for contract in contracts]
    return pl.DataFrame({
        "symbol": ["INTC"] * len(rows),
        "expiration": [contract[0] for contract, _ in rows],
        "strike": [contract[1] for contract, _ in rows],
        "right": [contract[2] for contract, _ in rows],
        "timestamp": [look_timestamp for _, look_timestamp in rows],
        "bid_size": [21] * len(rows), "bid_exchange": [5] * len(rows),
        "bid": [contract[3] for contract, _ in rows], "bid_condition": [50] * len(rows),
        "ask_size": [16] * len(rows), "ask_exchange": [43] * len(rows),
        "ask": [contract[4] for contract, _ in rows], "ask_condition": [50] * len(rows),
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


# Call and put quotes per strike; the call and put mids are closest at 42.5 (the at-the-money strike).
QUOTES_BY_STRIKE = {40.0: ((2.60, 2.70), (0.10, 0.14)), 42.5: ((0.80, 0.84), (0.78, 0.82)), 45.0: ((0.10, 0.12), (2.50, 2.60)), 60.0: ((0.01, 0.03), (17.40, 17.70))}
CONTRACTS_PER_DAY = 2 * len(QUOTES_BY_STRIKE) * 2
INTRADAY_ROWS_PER_DAY = CONTRACTS_PER_DAY * len(downloader.INTRADAY_LOOK_TIMES)


def near_expiry(trading_date):
    return (trading_date + datetime.timedelta(days=4)).isoformat()


def far_expiry(trading_date):
    return (trading_date + datetime.timedelta(days=30)).isoformat()


def contracts_for_trading_day(trading_date):
    return [(expiry, strike, right_word, bid, ask)
            for expiry in (near_expiry(trading_date), far_expiry(trading_date))
            for strike, (call_quote, put_quote) in QUOTES_BY_STRIKE.items()
            for right_word, (bid, ask) in (("CALL", call_quote), ("PUT", put_quote))]


def frames_for_trading_day(trading_date):
    contracts = contracts_for_trading_day(trading_date)
    return {
        "quotes": quote_frame(trading_date, contracts),
        "eod": end_of_day_frame(trading_date, [(expiry, strike, right_word, 0.52, 120, 14, bid, ask) for expiry, strike, right_word, bid, ask in contracts]),
        "open_interest": open_interest_frame(trading_date, [(expiry, strike, right_word, 300) for expiry, strike, right_word, _, _ in contracts]),
        "intraday_quotes": intraday_quote_frame(trading_date, contracts),
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


class FakeThetaData:
    """An in-memory ThetaData. frames_by_date[date][part] holds a day's answer for all expirations; a request for one
    expiration gets that expiration's rows (the day's whole answer when `ignores_the_expiration_asked_for`); a date or
    expiration without rows has no data. `failures` maps (part, date, "*" or expiration text) to a list of errors raised
    in turn before answering, or to one error raised every time. Only the latest login is valid, as with the real service."""

    def __init__(self, frames_by_date, failures=None, call_duration_seconds=0.005, on_request=None, has_options=True):
        self.frames_by_date = frames_by_date
        self.failures = {key: (list(errors) if isinstance(errors, list) else errors) for key, errors in (failures or {}).items()}
        self.call_duration_seconds = call_duration_seconds
        self.on_request = on_request
        self.has_options = has_options
        self.every_login_is_taken_at_once = False
        self.ignores_the_expiration_asked_for = False
        self.lock = threading.Lock()
        self.calls = []
        self.requests_in_flight = 0
        self.max_requests_in_flight = 0
        self.login_count = 0
        self.valid_login_number = None

    def log_in(self):
        with self.lock:
            self.login_count += 1
            self.valid_login_number = None if self.every_login_is_taken_at_once else self.login_count
            return FakeThetaClient(self, self.login_count)

    def another_program_logs_in(self):
        with self.lock:
            self.valid_login_number = None

    def expirations(self):
        return sorted({expiration for frames in self.frames_by_date.values() for frame in frames.values() for expiration in frame["expiration"].unique().to_list()})

    def respond(self, login_number, part_name, trading_date, expiration):
        expiration_key = expiration if expiration == "*" else expiration.isoformat()
        with self.lock:
            if login_number != self.valid_login_number:
                raise FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, SESSION_TAKEN_DETAILS)
            self.calls.append((part_name, trading_date, expiration_key))
            self.requests_in_flight += 1
            self.max_requests_in_flight = max(self.max_requests_in_flight, self.requests_in_flight)
        try:
            if self.on_request is not None:
                self.on_request(part_name, trading_date, expiration_key)
            time.sleep(self.call_duration_seconds)
            with self.lock:
                pending_errors = self.failures.get((part_name, trading_date, expiration_key))
                error = (pending_errors.pop(0) if pending_errors else None) if isinstance(pending_errors, list) else pending_errors
            if error is not None:
                raise error
            frame = self.frames_by_date.get(trading_date, {}).get(part_name)
            if frame is not None and expiration != "*" and not self.ignores_the_expiration_asked_for:
                frame = frame.filter(pl.col("expiration") == expiration_key)
            if frame is None or frame.height == 0:
                raise NoDataFoundError(f"No data found for: {part_name} {trading_date} {expiration_key}")
            return frame
        finally:
            with self.lock:
                self.requests_in_flight -= 1

    def calls_for(self, part_name, trading_date):
        return [expiration_key for called_part, called_date, expiration_key in self.calls if called_part == part_name and called_date == trading_date]


class FakeThetaClient:
    """One login to FakeThetaData, with the signatures of the library's ThetaClient methods the downloader calls."""

    def __init__(self, service, login_number):
        self.service = service
        self.login_number = login_number

    @staticmethod
    def check_expiration_and_max_dte(expiration, max_dte):
        """Every expiry is asked for: no request narrows the expiries with max_dte."""
        assert max_dte is None, max_dte
        assert expiration == "*" or isinstance(expiration, datetime.date), expiration

    def option_at_time_quote(self, symbol, start_date, end_date, time_of_day, expiration, strike="*", right="both", max_dte=None, strike_range=None):
        assert start_date == end_date and time_of_day == "10:00:00"
        self.check_expiration_and_max_dte(expiration, max_dte)
        return self.service.respond(self.login_number, "quotes", start_date, expiration)

    def option_history_eod(self, start_date, end_date, symbol, expiration, strike="*", right="both", max_dte=None, strike_range=None):
        assert start_date == end_date
        self.check_expiration_and_max_dte(expiration, max_dte)
        return self.service.respond(self.login_number, "eod", start_date, expiration)

    def option_history_open_interest(self, symbol, expiration, date=None, strike="*", right="both", max_dte=None, strike_range=None, start_date=None, end_date=None):
        self.check_expiration_and_max_dte(expiration, max_dte)
        return self.service.respond(self.login_number, "open_interest", date, expiration)

    def option_history_quote(self, symbol, expiration, interval="1s", date=None, strike="*", right="both", start_time="09:30:00", end_time="16:00:00",
                             max_dte=None, strike_range=None, start_date=None, end_date=None):
        assert (interval, start_time, end_time) == ("30m", "10:00:00", "15:30:00")
        self.check_expiration_and_max_dte(expiration, max_dte)
        return self.service.respond(self.login_number, "intraday_quotes", date, expiration)

    def option_list_expirations(self, symbol):
        with self.service.lock:
            if self.login_number != self.service.valid_login_number:
                raise FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, SESSION_TAKEN_DETAILS)
            self.service.calls.append(("expirations", None, "*"))
        if not self.service.has_options:
            raise NoDataFoundError(f"No data found for: option_list_expirations({symbol})")
        return pl.DataFrame({"symbol": [symbol] * len(self.service.expirations()), "expiration": self.service.expirations()})


def session_with(client):
    return downloader.ThetaDataSession(lambda: client, threading.Event(), NO_WAITS_BEFORE_LOGIN)


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


class FetchFrameWithRetriesTests(unittest.TestCase):
    def fetch(self, errors, retry_delays_seconds=NO_RETRY_DELAYS):
        attempts = []

        def perform_request(client):
            attempts.append(client)
            if len(attempts) <= len(errors):
                raise errors[len(attempts) - 1]
            return "frame"

        return downloader.fetch_frame_with_retries(session_with("client"), perform_request, "quotes INTC 2024-06-21", retry_delays_seconds), attempts

    def test_transient_errors_and_undecodable_answers_are_retried(self):
        frame, attempts = self.fetch([FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED, "Deadline Exceeded"), ValueError("could not decode the response")])
        self.assertEqual((frame, attempts), ("frame", ["client"] * 3))

    def test_retries_used_up_raise_request_failed(self):
        with self.assertRaisesRegex(downloader.RequestFailed, "UNAVAILABLE: Stream removed"):
            self.fetch([FakeRpcError(grpc.StatusCode.UNAVAILABLE, "Stream removed")] * (len(NO_RETRY_DELAYS) + 1))

    def test_stored_data_thetadata_cannot_read_is_not_retried(self):
        corrupt = FakeRpcError(grpc.StatusCode.INTERNAL, "Corrupt FIT data: record has more fields than the established tick width (6) near position 3478")
        with self.assertRaisesRegex(downloader.RequestFailed, "INTERNAL: Corrupt FIT data"):
            self.fetch([corrupt, None])
        attempts = []

        def corrupt_request(client):
            attempts.append(client)
            raise corrupt

        with self.assertRaises(downloader.RequestFailed):
            downloader.fetch_frame_with_retries(session_with("client"), corrupt_request, "quotes INTC 2024-06-21", NO_RETRY_DELAYS)
        self.assertEqual(attempts, ["client"])

    def test_a_request_waiting_out_a_retry_holds_no_request_slot(self):
        session = session_with("client")
        free_slots_while_waiting = []

        def count_free_slots(delay_seconds):
            taken = [session.request_slots.acquire(blocking=False) for _ in range(downloader.MAX_REQUESTS_IN_FLIGHT + 1)]
            free_slots_while_waiting.append(sum(taken))
            for was_taken in taken:
                if was_taken:
                    session.request_slots.release()

        errors = [FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED, "Deadline Exceeded")]

        def fails_once(client):
            if errors:
                raise errors.pop()
            return "frame"

        frame = downloader.fetch_frame_with_retries(session, fails_once, "quotes INTC 2024-06-21", (1,), sleep=count_free_slots)
        self.assertEqual((frame, free_slots_while_waiting), ("frame", [downloader.MAX_REQUESTS_IN_FLIGHT]))

    def test_each_request_is_timed_and_counted(self):
        session = session_with("client")

        def no_data(client):
            raise NoDataFoundError("No data found")

        with self.assertLogs("download_thetadata_symbol", level="INFO") as logs:
            downloader.fetch_frame_with_retries(session, lambda client: pl.DataFrame({"strike": [1.0, 2.0]}), "quotes INTC 2024-06-21 all expirations")
            downloader.fetch_frame_with_retries(session, no_data, "eod INTC 2024-06-21 all expirations")
        self.assertRegex(logs.output[0], r"quotes INTC 2024-06-21 all expirations: 2 rows in \d+\.\d s$")
        self.assertRegex(logs.output[1], r"eod INTC 2024-06-21 all expirations: no data in \d+\.\d s$")
        count_by_kind, _, _ = session.statistics.snapshot()
        self.assertEqual(dict(count_by_kind), {"quotes": 1, "eod": 1})

    def test_an_error_that_does_not_pass_is_not_retried(self):
        with self.assertRaisesRegex(downloader.RequestFailed, "INVALID_ARGUMENT: Invalid interval"):
            self.fetch([FakeRpcError(grpc.StatusCode.INVALID_ARGUMENT, "Invalid interval: 45m"), None])

    def test_a_refusal_is_not_a_request_failure(self):
        with self.assertRaises(downloader.RequestRefused) as raised:
            self.fetch([FakeRpcError(grpc.StatusCode.PERMISSION_DENIED, "requires a STANDARD subscription")])
        self.assertNotIsInstance(raised.exception, downloader.RequestFailed)

    def test_no_data_is_none(self):
        self.assertEqual(self.fetch([NoDataFoundError("No data found")])[0], None)


class RealLibraryRequestTests(unittest.TestCase):
    """The four requests through the library's own ThetaClient (built without a login, its gRPC stub replaced): the
    arguments the downloader passes are ones the library accepts, and they reach the request as intended."""

    trading_date = datetime.date(2024, 3, 25)
    expiration_date = datetime.date(2024, 4, 5)

    def setUp(self):
        class LoggedInElsewhere:
            auth_token = AuthToken(session_uuid="unit-test")
            email = "unit-test"
            api_key = None
            stock_subscription = options_subscription = index_subscription = 0
            mdds_type = "PROD"

        class RecordingStub:
            def __init__(self):
                self.requests = {}

            def __getattr__(self, method_name):
                def record(request, **keyword_arguments):
                    self.requests[method_name] = request
                    raise FakeRpcError(grpc.StatusCode.NOT_FOUND, "no data")
                return record

        with unittest.mock.patch("httpx.post", side_effect=AssertionError("the tests must never log in")):
            self.client = ThetaClient(existing_authorized_client=LoggedInElsewhere(), mdds_host="127.0.0.1", mdds_port="9", insecure_channel=True)
        self.client.stub = self.recording_stub = RecordingStub()

    def request_parameters(self, perform_request, expiration, method_name):
        with self.assertRaises(NoDataFoundError):
            perform_request(self.client, "INTC", self.trading_date, expiration)
        return self.recording_stub.requests[method_name].params

    def test_quotes_at_ten(self):
        parameters = self.request_parameters(downloader.request_quotes, "*", "GetOptionAtTimeQuote")
        self.assertEqual((parameters.contract_spec.symbol, parameters.contract_spec.expiration, parameters.contract_spec.strike, parameters.contract_spec.right),
                         ("INTC", "*", "*", "both"))
        self.assertEqual((parameters.start_date, parameters.end_date, parameters.time_of_day, parameters.HasField("max_dte")), ("2024-03-25", "2024-03-25", "10:00:00", False))
        parameters = self.request_parameters(downloader.request_quotes, self.expiration_date, "GetOptionAtTimeQuote")
        self.assertEqual((parameters.contract_spec.expiration, parameters.HasField("max_dte")), ("2024-04-05", False))

    def test_end_of_day(self):
        parameters = self.request_parameters(downloader.request_end_of_day, "*", "GetOptionHistoryEod")
        self.assertEqual((parameters.contract_spec.expiration, parameters.start_date, parameters.end_date, parameters.HasField("max_dte")), ("*", "2024-03-25", "2024-03-25", False))
        parameters = self.request_parameters(downloader.request_end_of_day, self.expiration_date, "GetOptionHistoryEod")
        self.assertEqual((parameters.contract_spec.expiration, parameters.HasField("max_dte")), ("2024-04-05", False))

    def test_open_interest(self):
        parameters = self.request_parameters(downloader.request_open_interest, "*", "GetOptionHistoryOpenInterest")
        self.assertEqual((parameters.contract_spec.expiration, parameters.date, parameters.HasField("max_dte")), ("*", "2024-03-25", False))
        parameters = self.request_parameters(downloader.request_open_interest, self.expiration_date, "GetOptionHistoryOpenInterest")
        self.assertEqual((parameters.contract_spec.expiration, parameters.HasField("max_dte")), ("2024-04-05", False))

    def test_intraday_quotes(self):
        parameters = self.request_parameters(downloader.request_intraday_quotes, "*", "GetOptionHistoryQuote")
        self.assertEqual((parameters.contract_spec.expiration, parameters.date, parameters.interval, parameters.start_time, parameters.end_time, parameters.HasField("max_dte")),
                         ("*", "2024-03-25", "30m", "10:00:00", "15:30:00", False))
        parameters = self.request_parameters(downloader.request_intraday_quotes, self.expiration_date, "GetOptionHistoryQuote")
        self.assertEqual((parameters.contract_spec.expiration, parameters.interval, parameters.HasField("max_dte")), ("2024-04-05", "30m", False))


class DayPlanningTests(unittest.TestCase):
    def test_a_weekday_counts_only_from_18_eastern(self):
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 26, 17, 59)), datetime.date(2024, 3, 25))
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 26, 18, 0)), datetime.date(2024, 3, 26))

    def test_monday_before_18_and_weekends_fall_back_to_friday(self):
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 25, 10, 0)), datetime.date(2024, 3, 22))
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 23, 20, 0)), datetime.date(2024, 3, 22))
        self.assertEqual(downloader.last_finished_session_date(eastern_time(2024, 3, 24, 23, 0)), datetime.date(2024, 3, 22))

    def test_plan_skips_weekends_and_the_unfinished_session_and_asks_only_for_what_a_day_lacks(self):
        stored_days = {
            "2024-03-21": downloader.StoredDay("complete", 462, has_intraday_quotes=True),   # fully stored
            "2024-03-22": downloader.StoredDay("complete", 462, has_intraday_quotes=False),  # stored before intraday quotes existed
            "2024-03-25": downloader.StoredDay("no_data", 0, has_intraday_quotes=False),     # a holiday needs nothing more
            "2024-01-02": downloader.StoredDay("complete", 400, has_intraday_quotes=False),  # outside the range
        }
        days_in_range, day_plans = downloader.plan_days(datetime.date(2024, 3, 21), datetime.date(2024, 3, 29), eastern_time(2024, 3, 27, 12, 0), stored_days)
        self.assertEqual(days_in_range, [datetime.date(2024, 3, 21), datetime.date(2024, 3, 22), datetime.date(2024, 3, 25), datetime.date(2024, 3, 26)])
        self.assertEqual(day_plans, [
            downloader.DayPlan(datetime.date(2024, 3, 22), fetch_morning_parts=False, fetch_intraday_quotes=True),
            downloader.DayPlan(datetime.date(2024, 3, 26), fetch_morning_parts=True, fetch_intraday_quotes=True),
        ])

    def test_plan_completes_the_parts_stored_with_the_earlier_cap_and_only_those(self):
        stored_days = {
            "2024-03-18": downloader.StoredDay("complete", 462, True, morning_parts_have_all_expiries=False, intraday_quotes_have_all_expiries=False),
            "2024-03-19": downloader.StoredDay("complete", 462, True, morning_parts_have_all_expiries=False),   # intraday quotes already whole
            "2024-03-20": downloader.StoredDay("complete", 462, True, intraday_quotes_have_all_expiries=False),  # morning parts already whole
            "2024-03-21": downloader.StoredDay("complete", 462, False, morning_parts_have_all_expiries=False),   # no intraday quotes yet: fetched whole
            "2024-03-22": downloader.StoredDay("complete", 462, True),                                          # whole
            "2024-03-25": downloader.StoredDay("no_data", 0, False, morning_parts_have_all_expiries=False),      # a holiday needs nothing
        }
        _, day_plans = downloader.plan_days(datetime.date(2024, 3, 18), datetime.date(2024, 3, 25), eastern_time(2024, 3, 26, 12, 0), stored_days)
        self.assertEqual(day_plans, [
            downloader.DayPlan(datetime.date(2024, 3, 18), False, False, complete_morning_parts=True, complete_intraday_quotes=True),
            downloader.DayPlan(datetime.date(2024, 3, 19), False, False, complete_morning_parts=True),
            downloader.DayPlan(datetime.date(2024, 3, 20), False, False, complete_intraday_quotes=True),
            downloader.DayPlan(datetime.date(2024, 3, 21), False, True, complete_morning_parts=True),
        ])

    def test_plan_is_empty_when_the_range_starts_after_the_last_session(self):
        self.assertEqual(downloader.plan_days(datetime.date(2024, 3, 26), datetime.date(2024, 3, 29), eastern_time(2024, 3, 26, 9, 0), {}), ([], []))


class RowMappingTests(unittest.TestCase):
    trading_date = datetime.date(2024, 3, 25)

    def test_quotes_map_rights_strikes_timestamps_and_keep_every_unexpired_contract(self):
        frame = quote_frame(self.trading_date, [
            ("2024-03-25", 42.5, "CALL", 0.5, 0.55),          # 0 days: kept
            ("2024-05-09", 40.0, "PUT", 13.950000000000001, 14.1),  # 45 days: kept, float noise rounded
            ("2026-01-16", 40.0, "PUT", 1.0, 1.1),            # 662 days (a LEAPS): kept
            ("2024-03-22", 40.0, "CALL", 0.0, 0.01),          # expired: dropped
            ("2024-04-05", 41.0, "PUT", float("nan"), 0.2),   # no bid price: NULL
        ])
        rows = downloader.map_quote_rows(frame, self.trading_date)
        self.assertEqual(rows, [
            ("2024-03-25", "2024-03-25", 42.5, "C", 0.5, 0.55, 11, 6, "2024-03-25T09:59:58.207-04:00"),
            ("2024-03-25", "2024-05-09", 40.0, "P", 13.95, 14.1, 11, 6, "2024-03-25T09:59:58.207-04:00"),
            ("2024-03-25", "2026-01-16", 40.0, "P", 1.0, 1.1, 11, 6, "2024-03-25T09:59:58.207-04:00"),
            ("2024-03-25", "2024-04-05", 41.0, "P", None, 0.2, 11, 6, "2024-03-25T09:59:58.207-04:00"),
        ])

    def test_end_of_day_keeps_every_unexpired_contract_and_stores_no_close_when_nothing_traded(self):
        frame = end_of_day_frame(self.trading_date, [
            ("2024-05-10", 40.0, "CALL", 0.31, 25, 4, 0.3, 0.33),  # 46 days: kept
            ("2025-01-17", 40.0, "CALL", 2.31, 5, 2, 2.3, 2.4),    # 298 days: kept
            ("2024-03-22", 40.0, "CALL", 0.0, 0, 0, 0.0, 0.01),    # expired: dropped
            ("2024-04-05", 54.0, "PUT", 0.0, 0, 0, 10.65, 12.35),  # no trades: close NULL, volume 0
        ])
        self.assertEqual(downloader.map_end_of_day_rows(frame, self.trading_date), [
            ("2024-03-25", "2024-05-10", 40.0, "C", 0.31, 25, 0.3, 0.33),
            ("2024-03-25", "2025-01-17", 40.0, "C", 2.31, 5, 2.3, 2.4),
            ("2024-03-25", "2024-04-05", 54.0, "P", None, 0, 10.65, 12.35),
        ])

    def test_open_interest_drops_expired_contracts_and_missing_values(self):
        frame = open_interest_frame(self.trading_date, [
            ("2024-03-22", 50.0, "CALL", 3260),  # expired last Friday, still in Monday's report: dropped
            ("2024-04-05", 54.0, "CALL", 86),
            ("2024-04-05", 55.0, "CALL", None),
        ])
        self.assertEqual(downloader.map_open_interest_rows(frame, self.trading_date), [("2024-03-25", "2024-04-05", 54.0, "C", 86)])

    def test_intraday_quotes_take_the_look_time_from_the_row_and_leave_quoted_at_empty(self):
        frame = intraday_quote_frame(self.trading_date, [
            ("2024-04-05", 42.0, "CALL", 0.8300000000000001, 0.84),
            ("2025-01-17", 42.0, "CALL", 3.0, 3.1),   # 298 days: kept
            ("2024-03-22", 42.0, "CALL", 0.0, 0.01),  # expired: dropped
        ], look_times=("10:00", "10:30", "15:30", "15:45"))  # 15:45 is not a look
        self.assertEqual(downloader.map_intraday_quote_rows(frame, self.trading_date), [
            ("2024-03-25", "10:00", "2024-04-05", 42.0, "C", 0.83, 0.84, 21, 16, None),
            ("2024-03-25", "10:00", "2025-01-17", 42.0, "C", 3.0, 3.1, 21, 16, None),
            ("2024-03-25", "10:30", "2024-04-05", 42.0, "C", 0.83, 0.84, 21, 16, None),
            ("2024-03-25", "10:30", "2025-01-17", 42.0, "C", 3.0, 3.1, 21, 16, None),
            ("2024-03-25", "15:30", "2024-04-05", 42.0, "C", 0.83, 0.84, 21, 16, None),
            ("2024-03-25", "15:30", "2025-01-17", 42.0, "C", 3.0, 3.1, 21, 16, None),
        ])

    def test_the_look_grid_is_every_30_minutes_from_10_00_to_15_30(self):
        self.assertEqual(downloader.INTRADAY_LOOK_TIMES, ("10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"))

    def test_repeated_contracts_keep_the_last_row(self):
        frame = open_interest_frame(self.trading_date, [("2024-04-05", 54.0, "CALL", 86), ("2024-04-05", 54.0, "CALL", 90)])
        self.assertEqual(downloader.map_open_interest_rows(frame, self.trading_date), [("2024-03-25", "2024-04-05", 54.0, "C", 90)])

    def test_no_frame_maps_to_no_rows(self):
        self.assertEqual(downloader.map_quote_rows(None, self.trading_date), [])
        self.assertEqual(downloader.map_intraday_quote_rows(None, self.trading_date), [])

    def test_an_unusable_answer_is_a_request_failure(self):
        frame = open_interest_frame(self.trading_date, [("2024-04-05", 54.0, "CALL", 86)]).drop("open_interest")
        with self.assertRaisesRegex(downloader.RequestFailed, "missing columns \\['open_interest'\\]"):
            downloader.map_open_interest_rows(frame, self.trading_date)
        frame = open_interest_frame(self.trading_date, [("2024-04-05", 54.0, "STRADDLE", 86)])
        with self.assertRaisesRegex(downloader.RequestFailed, "unknown option right"):
            downloader.map_open_interest_rows(frame, self.trading_date)


class StrikeWindowTests(unittest.TestCase):
    trading_date = datetime.date(2024, 3, 25)

    def quote_rows(self, contracts):
        return downloader.map_quote_rows(quote_frame(self.trading_date, contracts), self.trading_date)

    def test_at_the_money_is_where_call_and_put_mids_are_closest_in_the_nearest_expiry_a_day_out(self):
        rows = self.quote_rows([
            ("2024-03-25", 50.0, "CALL", 1.0, 1.1), ("2024-03-25", 50.0, "PUT", 1.0, 1.1),      # expires today: not used
            ("2024-03-28", 41.0, "CALL", 1.28, 1.29), ("2024-03-28", 41.0, "PUT", 0.98, 1.00),  # mids 0.295 apart
            ("2024-03-28", 41.5, "CALL", 1.04, 1.05), ("2024-03-28", 41.5, "PUT", 1.23, 1.25),  # mids 0.195 apart: closest
            ("2024-03-28", 42.0, "CALL", 0.83, 0.84), ("2024-03-28", 42.0, "PUT", 1.52, 1.55),
            ("2024-04-05", 45.0, "CALL", 0.50, 0.52), ("2024-04-05", 45.0, "PUT", 0.50, 0.52),  # a later expiry: not used
        ])
        self.assertEqual(downloader.find_at_the_money_strike(rows, self.trading_date), 41.5)

    def test_an_expiry_without_a_strike_quoted_on_both_sides_is_passed_over(self):
        rows = self.quote_rows([
            ("2024-03-28", 41.0, "CALL", 1.28, 1.29), ("2024-03-28", 42.0, "PUT", float("nan"), 1.0),
            ("2024-04-05", 45.0, "CALL", 0.50, 0.52), ("2024-04-05", 45.0, "PUT", 0.40, 0.42),
        ])
        self.assertEqual(downloader.find_at_the_money_strike(rows, self.trading_date), 45.0)
        self.assertIsNone(downloader.find_at_the_money_strike(rows[:2], self.trading_date))

    def test_window_keeps_strikes_within_the_percentage_of_at_the_money(self):
        intraday_rows = [("2024-03-25", "10:00", "2024-04-05", strike, "C", 1.0, 1.1, 1, 1, None) for strike in (29.9, 30.0, 50.0, 70.0, 70.1)]
        self.assertEqual([row[3] for row in downloader.keep_strikes_within_window(intraday_rows, 50.0, 40.0)], [30.0, 50.0, 70.0])


def create_option_row_tables(connection):
    """The file's slices as TEMP tables of rows, one per contract, named and laid out as PART_COLUMN_NAMES, so a test reads them as rows."""
    for part_name, column_names in downloader.PART_COLUMN_NAMES.items():
        connection.execute(f"CREATE TEMP TABLE {part_name} ({', '.join(column_names)})")
        connection.executemany(f"INSERT INTO temp.{part_name} VALUES ({', '.join('?' * len(column_names))})", downloader.read_part_rows(connection, part_name))


def change_part_rows(connection, part_name, trading_date_text, change):
    """Rewrites a day's rows of a part through `change` (a row in, a row out)."""
    rows = [change(row) for row in downloader.read_part_rows(connection, part_name, trading_date_text)]
    downloader.delete_part_rows_of_day(connection, part_name, trading_date_text)
    downloader.insert_part_rows(connection, part_name, rows)


FIRST_VERSION_SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE days (trading_date TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')), quote_rows INTEGER NOT NULL,
  eod_rows INTEGER NOT NULL, open_interest_rows INTEGER NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE quotes (trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL, option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  bid REAL, ask REAL, bid_size INTEGER, ask_size INTEGER, quoted_at TEXT, PRIMARY KEY (trading_date, expiry, strike, option_right)) WITHOUT ROWID;
CREATE TABLE eod (trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL, option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  close REAL, volume INTEGER, bid REAL, ask REAL, PRIMARY KEY (trading_date, expiry, strike, option_right)) WITHOUT ROWID;
CREATE TABLE open_interest (trading_date TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL, option_right TEXT NOT NULL CHECK (option_right IN ('C', 'P')),
  open_interest INTEGER NOT NULL, PRIMARY KEY (trading_date, expiry, strike, option_right)) WITHOUT ROWID;
INSERT INTO meta VALUES ('symbol', 'INTC'), ('schema_version', '1'), ('quote_time_et', '10:00:00'), ('max_dte', '45'), ('created_at', '2026-10-12T04:00:00.000Z');
INSERT INTO days VALUES ('2024-03-25', 'complete', 1, 0, 0, '2026-10-12T04:00:01.000Z');
INSERT INTO quotes VALUES ('2024-03-25', '2024-04-05', 42.5, 'C', 0.5, 0.55, 1, 1, NULL);
"""


class SymbolFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.file_path = Path(self.temporary_directory.name) / "INTC.sqlite"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def open_file(self, symbol="INTC", created_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)):
        return downloader.open_symbol_file(self.file_path, symbol, created_at)

    def test_creates_the_schema(self):
        connection = self.open_file(created_at=datetime.datetime(2026, 10, 12, 3, 4, 5, 678000, tzinfo=datetime.timezone.utc))
        try:
            self.assertEqual(dict(connection.execute("SELECT key, value FROM meta")), {
                "symbol": "INTC", "schema_version": "4", "quote_time_et": "10:00:00", "max_dte": "all", "intraday_interval": "30m",
                "intraday_window": "10:00-15:30", "created_at": "2026-10-12T03:04:05.678Z"})
            self.assertEqual(connection.execute("PRAGMA page_size").fetchone()[0], 16384)
            table_names = [name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
            columns_by_table = {table_name: [column[1] for column in connection.execute(f"PRAGMA table_info({table_name})")] for table_name in table_names if table_name != "meta"}
            self.assertEqual(columns_by_table, {
                "days": ["trading_date", "status", "quote_rows", "eod_rows", "open_interest_rows", "fetched_at", "all_expiries"],
                "intraday_days": ["trading_date", "status", "look_count", "quote_rows", "strike_window_pct", "fetched_at", "all_expiries"],
                "day_issues": ["trading_date", "part", "expiry", "message", "recorded_at", "attempts"],
                "unavailable_days": ["trading_date", "reason", "attempts", "last_attempt_at"],
                "ten_oclock_quote_slices": ["key", "call_count", "put_count", "has_ask_above_zero", "data"],
                "intraday_quote_slices": ["key", "call_count", "put_count", "data"],
                "end_of_day_slices": ["key", "call_count", "put_count", "has_volume", "data"],
                "open_interest_slices": ["key", "call_count", "put_count", "data"],
            })
            for rejected_insert in ("INSERT INTO days VALUES ('2024-03-25', 'partial', 0, 0, 0, 'x', 1)",
                                    "INSERT INTO intraday_days VALUES ('2024-03-25', 'partial', 0, 0, NULL, 'x', 1)",
                                    "INSERT INTO day_issues VALUES ('2024-03-25', 'greeks', NULL, 'm', 'x', 1)"):
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(rejected_insert)
        finally:
            connection.close()

    def test_leaves_a_file_of_an_earlier_schema_untouched(self):
        for version in ("1", "3"):
            with self.subTest(version):
                earlier_file = sqlite3.connect(self.file_path)
                earlier_file.executescript(FIRST_VERSION_SCHEMA.replace("('schema_version', '1')", f"('schema_version', '{version}')"))
                earlier_file.close()
                with self.assertRaisesRegex(downloader.DownloadFailed, f"has schema version {version}; this downloader writes version 4: move the file away and download the symbol again"):
                    self.open_file()
                check = sqlite3.connect(self.file_path)
                try:
                    self.assertEqual(sorted(name for (name,) in check.execute("SELECT name FROM sqlite_master WHERE type = 'table'")), ["days", "eod", "meta", "open_interest", "quotes"])
                finally:
                    check.close()
                self.file_path.unlink()

    def test_reopening_keeps_created_at_and_rejects_another_symbol(self):
        self.open_file().close()
        connection = self.open_file(created_at=datetime.datetime(2026, 2, 2, tzinfo=datetime.timezone.utc))
        self.assertEqual(connection.execute("SELECT value FROM meta WHERE key = 'created_at'").fetchone()[0], "2026-01-01T00:00:00.000Z")
        connection.close()
        with self.assertRaisesRegex(downloader.DownloadFailed, "symbol='INTC'"):
            self.open_file(symbol="SMCI")

    def test_a_failing_day_write_leaves_nothing_behind(self):
        connection = self.open_file()
        try:
            repeated_quote = ("2024-03-25", "2024-04-05", 42.5, "C", 0.5, 0.55, 1, 1, None)
            part_results = {"quotes": downloader.DayPartResult([repeated_quote, repeated_quote]), "eod": downloader.DayPartResult([]),
                            "open_interest": downloader.DayPartResult([]), "intraday_quotes": downloader.DayPartResult([])}
            with self.assertRaises(sqlite3.IntegrityError):
                downloader.store_day(connection, downloader.DayPlan(datetime.date(2024, 3, 25), True, True), part_results, None, datetime.datetime.now(datetime.timezone.utc), datetime.date.max)
            self.assertEqual(connection.execute("SELECT (SELECT count(*) FROM ten_oclock_quote_slices) + (SELECT count(*) FROM days)").fetchone()[0], 0)
            self.assertFalse(connection.in_transaction)
        finally:
            connection.close()

    def test_storing_a_day_again_after_its_days_row_was_deleted_replaces_its_rows(self):
        connection = self.open_file()
        try:
            day_plan = downloader.DayPlan(datetime.date(2024, 3, 25), True, True)
            quote = ("2024-03-25", "2024-04-05", 42.5, "C", 0.5, 0.55, 1, 1, None)

            def part_results(bid):
                return {"quotes": downloader.DayPartResult([quote[:4] + (bid,) + quote[5:]]), "eod": downloader.DayPartResult([]),
                        "open_interest": downloader.DayPartResult([]), "intraday_quotes": downloader.DayPartResult([])}

            downloader.store_day(connection, day_plan, part_results(0.5), None, datetime.datetime.now(datetime.timezone.utc), datetime.date.max)
            connection.execute("DELETE FROM days WHERE trading_date = '2024-03-25'")
            downloader.store_day(connection, day_plan, part_results(0.6), None, datetime.datetime.now(datetime.timezone.utc), datetime.date.max)
            self.assertEqual([row[4] for row in downloader.read_part_rows(connection, "quotes")], [0.6])
            self.assertEqual(connection.execute("SELECT status, look_count, quote_rows FROM intraday_days").fetchall(), [("no_data", 0, 0)])
        finally:
            connection.close()


class WaitForDayRequestsTests(unittest.TestCase):
    def setUp(self):
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.release_running_request = threading.Event()

    def tearDown(self):
        self.release_running_request.set()
        self.executor.shutdown()

    def test_a_failed_request_is_raised_without_waiting_for_the_days_other_requests(self):
        def refused_request():
            raise downloader.RequestRefused("ThetaData refused eod INTC 2024-03-26")

        still_running = self.executor.submit(self.release_running_request.wait, 30)
        refused = self.executor.submit(refused_request)
        with self.assertRaisesRegex(downloader.RequestRefused, "refused eod INTC 2024-03-26"):
            downloader.wait_for_day_requests([still_running, refused], threading.Event())
        self.assertFalse(still_running.done())

    def test_returns_once_every_request_has_finished(self):
        futures = [self.executor.submit(lambda: "rows"), self.executor.submit(lambda: "more rows")]
        downloader.wait_for_day_requests(futures, threading.Event())
        self.assertEqual([future.result() for future in futures], ["rows", "more rows"])

    def test_a_stop_request_is_raised_while_a_request_is_still_running(self):
        stop_requested = threading.Event()
        stop_requested.set()
        with self.assertRaises(downloader.DownloadCancelled):
            downloader.wait_for_day_requests([self.executor.submit(self.release_running_request.wait, 30)], stop_requested)


class DownloadRunTests(unittest.TestCase):
    """run_download end to end against the in-memory ThetaData: 2024-03-25..29, Good Friday 29 March has no data."""

    trading_dates = [datetime.date(2024, 3, 25), datetime.date(2024, 3, 26), datetime.date(2024, 3, 27), datetime.date(2024, 3, 28)]
    holiday = datetime.date(2024, 3, 29)
    corrupt = FakeRpcError(grpc.StatusCode.INTERNAL, "Corrupt FIT data: record has more fields than the established tick width (1) near position 2779")

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.data_directory = Path(self.temporary_directory.name) / "backtest-data"
        self.frames_by_date = {trading_date: frames_for_trading_day(trading_date) for trading_date in self.trading_dates}

    def tearDown(self):
        self.temporary_directory.cleanup()

    def run_downloader(self, service, stop_requested=None, start="2024-03-25", end="2024-03-29", extra_arguments=(), now=None):
        events = []
        exit_code = downloader.run_download(
            ["--symbol", "intc", "--start", start, "--end", end, "--data-dir", str(self.data_directory), *extra_arguments],
            events.append, stop_requested or threading.Event(), service.log_in, NO_RETRY_DELAYS, NO_EXPIRATION_BY_EXPIRATION_RETRY_DELAYS, NO_WAITS_BEFORE_LOGIN,
            **({"clock": lambda: now} if now else {}))
        return exit_code, events

    def read_database(self, query, parameters=()):
        connection = sqlite3.connect(self.data_directory / "INTC.sqlite")
        try:
            create_option_row_tables(connection)
            return connection.execute(query, parameters).fetchall()
        finally:
            connection.close()

    def stored_days(self):
        return self.read_database("""SELECT d.trading_date, d.status, d.quote_rows, d.eod_rows, d.open_interest_rows, i.status, i.look_count, i.quote_rows
                                     FROM days d LEFT JOIN intraday_days i ON i.trading_date = d.trading_date ORDER BY d.trading_date""")

    def assert_service_checked_once(self, service, part_name, earlier_day):
        """Before asking expiration by expiration, the service was checked once: with the earlier day's part for one
        expiration, when that day was stored by then, or else (days are fetched ahead) with a second expirations request."""
        expiration_requests = sum(1 for called_part, _, _ in service.calls if called_part == "expirations")
        self.assertIn((service.calls_for(part_name, earlier_day), expiration_requests), [(["*", near_expiry(earlier_day)], 1), (["*"], 2)])

    def assert_every_stored_day_is_whole(self):
        mismatches = self.read_database("""
            SELECT d.trading_date FROM days d
            WHERE d.quote_rows != (SELECT count(*) FROM quotes q WHERE q.trading_date = d.trading_date)
               OR d.eod_rows != (SELECT count(*) FROM eod e WHERE e.trading_date = d.trading_date)
               OR d.open_interest_rows != (SELECT count(*) FROM open_interest o WHERE o.trading_date = d.trading_date)
            UNION ALL
            SELECT i.trading_date FROM intraday_days i
            WHERE i.quote_rows != (SELECT count(*) FROM intraday_quotes q WHERE q.trading_date = i.trading_date)
               OR i.look_count != (SELECT count(DISTINCT look_time) FROM intraday_quotes q WHERE q.trading_date = i.trading_date)
               OR NOT EXISTS (SELECT 1 FROM days d WHERE d.trading_date = i.trading_date AND d.status = 'complete')""")
        self.assertEqual(mismatches, [])
        orphan_dates = self.read_database("""
            SELECT trading_date FROM (SELECT trading_date FROM quotes UNION SELECT trading_date FROM eod UNION SELECT trading_date FROM open_interest)
            WHERE trading_date NOT IN (SELECT trading_date FROM days)
            UNION ALL
            SELECT DISTINCT trading_date FROM intraday_quotes WHERE trading_date NOT IN (SELECT trading_date FROM intraday_days)""")
        self.assertEqual(orphan_dates, [])

    whole_day = ("complete", CONTRACTS_PER_DAY, CONTRACTS_PER_DAY, CONTRACTS_PER_DAY, "complete", 12, INTRADAY_ROWS_PER_DAY)

    def test_downloads_every_part_of_every_day_and_resumes_with_nothing_to_fetch(self):
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[0], {"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 0})
        self.assertEqual([event["lastDate"] for event in events[1:-1]], ["2024-03-25", "2024-03-26", "2024-03-27", "2024-03-28", "2024-03-29"])
        self.assertEqual(events[1], {"type": "progress", "daysDone": 1, "daysTotal": 5, "lastDate": "2024-03-25", "quoteRows": CONTRACTS_PER_DAY})
        self.assertEqual(events[-1], {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0})
        self.assertEqual(self.stored_days(), [("2024-03-25",) + self.whole_day, ("2024-03-26",) + self.whole_day, ("2024-03-27",) + self.whole_day,
                                              ("2024-03-28",) + self.whole_day, ("2024-03-29", "no_data", 0, 0, 0, None, None, None)])
        self.assertEqual(self.read_database("SELECT * FROM intraday_quotes WHERE trading_date = '2024-03-25' AND strike = 42.5 AND option_right = 'C' AND look_time IN ('10:00', '15:30') AND expiry = '2024-03-29'"), [
            ("2024-03-25", "10:00", "2024-03-29", 42.5, "C", 0.8, 0.84, 21, 16, None), ("2024-03-25", "15:30", "2024-03-29", 42.5, "C", 0.8, 0.84, 21, 16, None)])
        self.assertEqual(self.read_database("SELECT strike_window_pct FROM intraday_days WHERE trading_date = '2024-03-25'"), [(None,)])
        self.assert_every_stored_day_is_whole()
        self.assertEqual((service.max_requests_in_flight, service.login_count), (2, 1))
        self.assertEqual({expiration_key for _, _, expiration_key in service.calls}, {"*"})

        resumed_service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(resumed_service)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events, [{"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 5},
                                  {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}])
        self.assertEqual((resumed_service.calls, resumed_service.login_count), ([], 0))

    def test_a_longer_range_after_a_partial_download_fetches_only_the_new_days(self):
        self.run_downloader(FakeThetaData(self.frames_by_date), end="2024-03-26")
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[0], {"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 2})
        self.assertEqual(sorted({trading_date for _, trading_date, _ in service.calls if trading_date}), [datetime.date(2024, 3, 27), datetime.date(2024, 3, 28), self.holiday])

    def test_a_file_without_intraday_quotes_gets_only_those(self):
        self.run_downloader(FakeThetaData(self.frames_by_date))
        connection = sqlite3.connect(self.data_directory / "INTC.sqlite")
        for trading_date_text in ("2024-03-26", "2024-03-28"):
            downloader.delete_part_rows_of_day(connection, "intraday_quotes", trading_date_text)
        connection.execute("DELETE FROM intraday_days WHERE trading_date IN ('2024-03-26', '2024-03-28')")
        connection.commit()
        connection.close()
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[0], {"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 3})
        self.assertEqual(events[1], {"type": "progress", "daysDone": 4, "daysTotal": 5, "lastDate": "2024-03-26", "quoteRows": CONTRACTS_PER_DAY})
        self.assertEqual(events[-1], {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0})
        self.assertEqual(sorted(call for call in service.calls if call[0] != "expirations"),
                         [("intraday_quotes", datetime.date(2024, 3, 26), "*"), ("intraday_quotes", datetime.date(2024, 3, 28), "*")])
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)
        self.assert_every_stored_day_is_whole()

    def test_the_strike_window_narrows_intraday_quotes_only(self):
        exit_code, _ = self.run_downloader(FakeThetaData(self.frames_by_date), end="2024-03-25", extra_arguments=("--intraday-strike-window-pct", "20"))
        self.assertEqual(exit_code, 0)
        self.assertEqual(self.read_database("SELECT DISTINCT strike FROM intraday_quotes ORDER BY strike"), [(40.0,), (42.5,), (45.0,)])
        self.assertEqual(self.read_database("SELECT DISTINCT strike FROM quotes ORDER BY strike"), [(40.0,), (42.5,), (45.0,), (60.0,)])
        self.assertEqual(self.read_database("SELECT status, look_count, quote_rows, strike_window_pct FROM intraday_days"), [("complete", 12, 2 * 3 * 2 * 12, 20.0)])
        self.assert_every_stored_day_is_whole()

    def test_the_strike_window_uses_the_stored_ten_o_clock_quotes_when_only_intraday_quotes_are_fetched(self):
        self.run_downloader(FakeThetaData(self.frames_by_date), end="2024-03-25")
        connection = sqlite3.connect(self.data_directory / "INTC.sqlite")
        connection.executescript("DELETE FROM intraday_quote_slices; DELETE FROM intraday_days;")
        connection.close()
        self.run_downloader(FakeThetaData(self.frames_by_date), end="2024-03-25", extra_arguments=("--intraday-strike-window-pct", "20"))
        self.assertEqual(self.read_database("SELECT DISTINCT strike FROM intraday_quotes ORDER BY strike"), [(40.0,), (42.5,), (45.0,)])

    # --- a file stored with the earlier 45-day cap

    def leaps_expiry(self, trading_date):
        return (trading_date + datetime.timedelta(days=300)).isoformat()

    def frames_with_leaps(self):
        """Each day's answers with a 300-day expiry added to every part."""
        frames_by_date = {}
        for trading_date in self.trading_dates:
            contracts = contracts_for_trading_day(trading_date) + [(self.leaps_expiry(trading_date), 40.0, right_word, 6.0, 6.2) for right_word in ("CALL", "PUT")]
            frames_by_date[trading_date] = {
                "quotes": quote_frame(trading_date, contracts),
                "eod": end_of_day_frame(trading_date, [(expiry, strike, right_word, 0.52, 120, 14, bid, ask) for expiry, strike, right_word, bid, ask in contracts]),
                "open_interest": open_interest_frame(trading_date, [(expiry, strike, right_word, 300) for expiry, strike, right_word, _, _ in contracts]),
                "intraday_quotes": intraday_quote_frame(trading_date, contracts),
            }
        return frames_by_date

    def store_with_the_earlier_cap(self, extra_arguments=()):
        """A complete download of the days without the 300-day expiry, its days then flagged as stored with the earlier
        45-day cap (all_expiries 0), and one stored quote changed."""
        self.run_downloader(FakeThetaData(self.frames_by_date), extra_arguments=extra_arguments)
        connection = sqlite3.connect(self.data_directory / "INTC.sqlite")
        connection.executescript("UPDATE days SET all_expiries = 0 WHERE status = 'complete'; UPDATE intraday_days SET all_expiries = 0;")
        change_part_rows(connection, "quotes", "2024-03-26", lambda row: row[:4] + (0.77,) + row[5:] if row[2] == 42.5 and row[3] == "C" else row)
        connection.commit()
        connection.close()

    def test_a_file_stored_with_the_earlier_cap_is_completed_to_every_expiry_adding_only_what_it_lacks(self):
        self.store_with_the_earlier_cap()
        service = FakeThetaData(self.frames_with_leaps())
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 0)
        # The holiday was whole already; the four complete days are completed, each counted when done.
        self.assertEqual(events[0], {"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 1})
        self.assertEqual([event["lastDate"] for event in events[1:-1]], ["2024-03-25", "2024-03-26", "2024-03-27", "2024-03-28"])
        self.assertEqual(events[-1], {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0})
        whole_day_with_leaps = ("complete", CONTRACTS_PER_DAY + 2, CONTRACTS_PER_DAY + 2, CONTRACTS_PER_DAY + 2, "complete", 12, INTRADAY_ROWS_PER_DAY + 2 * 12)
        self.assertEqual(self.stored_days()[:4], [(trading_date.isoformat(),) + whole_day_with_leaps for trading_date in self.trading_dates])
        self.assertEqual(self.read_database("SELECT count(*) FROM quotes WHERE expiry > date(trading_date, '+45 days')"), [(4 * 2,)])
        self.assertEqual(self.read_database("SELECT count(*) FROM intraday_quotes WHERE expiry > date(trading_date, '+45 days')"), [(4 * 2 * 12,)])
        # A row the file held is left as it was, though the new answer differs.
        self.assertEqual(self.read_database("SELECT DISTINCT bid FROM quotes WHERE trading_date = '2024-03-26' AND strike = 42.5 AND option_right = 'C'"), [(0.77,)])
        self.assertEqual(self.read_database("SELECT DISTINCT all_expiries FROM days UNION SELECT DISTINCT all_expiries FROM intraday_days"), [(1,)])
        self.assertEqual(dict(self.read_database("SELECT key, value FROM meta WHERE key IN ('max_dte', 'schema_version')")), {"max_dte": "all", "schema_version": "4"})
        self.assertEqual(sorted({call[0] for call in service.calls if call[1] == self.trading_dates[0]}), ["eod", "intraday_quotes", "open_interest", "quotes"])
        self.assertEqual({expiration_key for _, _, expiration_key in service.calls}, {"*"})
        self.assert_every_stored_day_is_whole()
        # Nothing is left to fetch.
        resumed_service = FakeThetaData(self.frames_with_leaps())
        self.assertEqual(self.run_downloader(resumed_service)[1][0], {"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 5})
        self.assertEqual(resumed_service.calls, [])

    def test_completing_intraday_quotes_keeps_the_strike_window_the_day_was_stored_with(self):
        self.store_with_the_earlier_cap(extra_arguments=("--intraday-strike-window-pct", "20"))
        exit_code, _ = self.run_downloader(FakeThetaData(self.frames_with_leaps()))
        self.assertEqual(exit_code, 0)
        # The 300-day contracts are at strike 40, inside 20% of the 42.5 at-the-money strike; strike 60 stays out.
        self.assertEqual(self.read_database("SELECT DISTINCT strike FROM intraday_quotes ORDER BY strike"), [(40.0,), (42.5,), (45.0,)])
        self.assertEqual(self.read_database("SELECT count(*) FROM intraday_quotes WHERE trading_date = '2024-03-25' AND expiry = ?", (self.leaps_expiry(self.trading_dates[0]),)), [(2 * 12,)])
        self.assert_every_stored_day_is_whole()

    def test_completing_a_day_whose_request_for_all_expirations_keeps_failing_asks_only_beyond_45_days(self):
        self.store_with_the_earlier_cap()
        failing_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_with_leaps(), failures={("quotes", failing_day, "*"): self.corrupt})
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]["daysDone"]), (0, 5))
        # Asked for once (ThetaData cannot read it), then every listed expiration beyond 45 days, the 300-day expiries of the
        # other days included (no data that day).
        self.assertEqual(service.calls_for("quotes", failing_day)[0], "*")
        self.assertEqual(sorted(service.calls_for("quotes", failing_day)[1:]),
                         [expiration for expiration in service.expirations() if expiration > (failing_day + datetime.timedelta(days=45)).isoformat()])
        self.assertEqual(self.read_database("SELECT count(*) FROM day_issues"), [(0,)])
        self.assertEqual(self.read_database("SELECT count(*) FROM quotes WHERE trading_date = ?", (failing_day.isoformat(),)), [(CONTRACTS_PER_DAY + 2,)])

    def test_a_completion_whose_request_for_all_expirations_keeps_failing_with_nothing_listed_beyond_45_days_completes_the_day(self):
        self.store_with_the_earlier_cap()
        failing_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_by_date, failures={("quotes", failing_day, "*"): self.corrupt})
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]["daysDone"], events[-1]["daysWithIssues"]), (0, 5, 0))
        self.assertEqual(service.calls_for("quotes", failing_day)[len(NO_RETRY_DELAYS) + 1:], [])
        self.assertEqual(self.read_database("SELECT all_expiries, quote_rows FROM days WHERE trading_date = ?", (failing_day.isoformat(),)), [(1, CONTRACTS_PER_DAY)])
        self.assert_every_stored_day_is_whole()

    def test_a_completion_that_cannot_retrieve_a_part_leaves_the_day_as_it_was_and_completes_it_on_the_next_run(self):
        self.store_with_the_earlier_cap()
        failing_day = self.trading_dates[2]
        leaps = self.leaps_expiry(failing_day)
        failures = {("eod", failing_day, "*"): self.corrupt, ("eod", failing_day, leaps): self.corrupt}
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_with_leaps(), failures=failures))
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[-1], {"type": "done", "daysDone": 4, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0})
        self.assertEqual(self.read_database("SELECT all_expiries, quote_rows, eod_rows FROM days WHERE trading_date = ?", (failing_day.isoformat(),)), [(0, CONTRACTS_PER_DAY, CONTRACTS_PER_DAY)])
        self.assertEqual(self.read_database("SELECT count(*) FROM quotes WHERE trading_date = ?", (failing_day.isoformat(),)), [(CONTRACTS_PER_DAY,)])
        # Its intraday quotes were completed all the same.
        self.assertEqual(self.read_database("SELECT all_expiries FROM intraday_days WHERE trading_date = ?", (failing_day.isoformat(),)), [(1,)])
        # The next run completes the morning parts only.
        service = FakeThetaData(self.frames_with_leaps())
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[0]["daysDone"], events[-1]["daysDone"]), (0, 4, 5))
        self.assertEqual(sorted({call[0] for call in service.calls if call[1] == failing_day}), ["eod", "open_interest", "quotes"])
        self.assert_every_stored_day_is_whole()

    def test_a_piece_left_out_earlier_is_settled_when_the_completion_brings_its_rows(self):
        self.store_with_the_earlier_cap()
        day = self.trading_dates[0]
        connection = sqlite3.connect(self.data_directory / "INTC.sqlite")
        connection.execute("DELETE FROM end_of_day_slices WHERE key = ?", (downloader.slices.slice_key(downloader.slices.day_number_of(day), 0, (datetime.date.fromisoformat(far_expiry(day)) - day).days),))
        connection.execute("UPDATE days SET eod_rows = eod_rows - ? WHERE trading_date = ?", (CONTRACTS_PER_DAY // 2, day.isoformat()))
        connection.execute("INSERT INTO day_issues (trading_date, part, expiry, message, recorded_at, attempts) VALUES (?, 'eod', ?, 'INTERNAL: Corrupt FIT data', 'x', 4)",
                           (day.isoformat(), far_expiry(day)))
        connection.commit()
        connection.close()
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_with_leaps()))
        self.assertEqual((exit_code, events[-1]["daysWithIssues"]), (0, 0))
        self.assertEqual(self.read_database("SELECT count(*) FROM eod WHERE trading_date = ?", (day.isoformat(),)), [(CONTRACTS_PER_DAY + 2,)])
        self.assert_every_stored_day_is_whole()

    def test_never_more_than_two_requests_in_flight(self):
        service = FakeThetaData(self.frames_by_date, call_duration_seconds=0.02)
        self.run_downloader(service)
        self.assertEqual(len([call for call in service.calls if call[0] != "expirations"]), 5 * 4)
        self.assertEqual(service.max_requests_in_flight, 2)

    def test_a_transient_error_is_retried(self):
        service = FakeThetaData(self.frames_by_date, failures={("quotes", self.trading_dates[0], "*"): [FakeRpcError(grpc.StatusCode.UNAVAILABLE, "connection reset")]})
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]["type"]), (0, "done"))
        self.assertEqual(service.calls_for("quotes", self.trading_dates[0]), ["*", "*"])

    # --- a day ThetaData cannot serve

    def test_a_request_for_all_expirations_that_keeps_failing_is_retried_then_made_expiration_by_expiration(self):
        failing_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_by_date, failures={("quotes", failing_day, "*"): FakeRpcError(grpc.StatusCode.UNAVAILABLE, "Stream removed")})
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[-1], {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0})
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)
        self.assertEqual(self.read_database("SELECT count(*) FROM day_issues"), [(0,)])
        quote_calls = service.calls_for("quotes", failing_day)
        self.assertEqual(quote_calls[:len(NO_RETRY_DELAYS) + 1], ["*"] * (len(NO_RETRY_DELAYS) + 1))
        self.assertEqual(sorted(quote_calls[len(NO_RETRY_DELAYS) + 1:]), [expiration for expiration in service.expirations() if expiration >= "2024-03-26"])
        self.assert_service_checked_once(service, "quotes", self.trading_dates[0])
        self.assert_every_stored_day_is_whole()

    def test_a_request_for_all_expirations_thetadata_cannot_read_is_made_expiration_by_expiration_at_once(self):
        corrupt_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_by_date, failures={("quotes", corrupt_day, "*"): self.corrupt}, call_duration_seconds=0.02)
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[-1], {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0})
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)
        quote_calls = service.calls_for("quotes", corrupt_day)
        self.assertEqual(quote_calls[0], "*")
        self.assertEqual(sorted(quote_calls[1:]), [expiration for expiration in service.expirations() if expiration >= "2024-03-26"])
        self.assert_service_checked_once(service, "quotes", self.trading_dates[0])
        self.assertEqual(service.max_requests_in_flight, downloader.MAX_REQUESTS_IN_FLIGHT)
        self.assert_every_stored_day_is_whole()

    def test_expirations_asked_for_one_by_one_use_both_request_slots_and_keep_their_order(self):
        corrupt_day = self.trading_dates[1]
        lock = threading.Lock()
        in_flight, most_in_flight = [0], [0]

        def track(part_name, trading_date, expiration_key):
            if expiration_key != "*":
                with lock:
                    in_flight[0] += 1
                    most_in_flight[0] = max(most_in_flight[0], in_flight[0])
                time.sleep(0.02)
                with lock:
                    in_flight[0] -= 1

        service = FakeThetaData(self.frames_with_leaps(), failures={("quotes", corrupt_day, "*"): self.corrupt, ("quotes", corrupt_day, near_expiry(corrupt_day)): self.corrupt},
                                on_request=track)
        session = downloader.ThetaDataSession(service.log_in, threading.Event(), NO_WAITS_BEFORE_LOGIN)
        expiration_dates = [datetime.date.fromisoformat(expiration) for expiration in service.expirations()]
        quotes = downloader.DAY_PART_BY_NAME["quotes"]
        result = downloader.fetch_day_part(session, "INTC", corrupt_day, quotes, expiration_dates, downloader.StoredDataReferences(), NO_RETRY_DELAYS,
                                           NO_EXPIRATION_BY_EXPIRATION_RETRY_DELAYS)
        self.assertEqual(most_in_flight[0], downloader.MAX_REQUESTS_IN_FLIGHT)
        # As when the expirations were asked for one after another: rows and issues in expiration order.
        in_range = [expiration for expiration in expiration_dates if corrupt_day <= expiration <= corrupt_day + datetime.timedelta(days=downloader.EXPIRATION_BY_EXPIRATION_MAX_DAYS_TO_EXPIRY)]
        one_after_another = []
        for expiration in in_range:
            if expiration.isoformat() != near_expiry(corrupt_day):
                one_after_another.extend(downloader.map_quote_rows(self.frames_with_leaps()[corrupt_day]["quotes"].filter(pl.col("expiration") == expiration.isoformat()), corrupt_day))
        self.assertEqual(result.rows, one_after_another)
        self.assertEqual([issue[0] for issue in result.issues], [near_expiry(corrupt_day)])

    def test_an_expiration_that_still_fails_is_left_out_and_recorded(self):
        corrupt_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_by_date, failures={("quotes", corrupt_day, "*"): self.corrupt, ("quotes", corrupt_day, far_expiry(corrupt_day)): self.corrupt})
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 0)
        self.assertEqual(events[-1], {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 1})
        self.assertEqual(self.stored_days()[1], ("2024-03-26", "complete", CONTRACTS_PER_DAY // 2, CONTRACTS_PER_DAY, CONTRACTS_PER_DAY, "complete", 12, INTRADAY_ROWS_PER_DAY))
        self.assertEqual(self.read_database("SELECT DISTINCT expiry FROM quotes WHERE trading_date = '2024-03-26'"), [(near_expiry(corrupt_day),)])
        issues = self.read_database("SELECT trading_date, part, expiry, message FROM day_issues")
        self.assertEqual([issue[:3] for issue in issues], [("2024-03-26", "quotes", far_expiry(corrupt_day))])
        self.assertIn("INTERNAL: Corrupt FIT data", issues[0][3])
        self.assert_every_stored_day_is_whole()

    def test_a_day_whose_ten_o_clock_quotes_cannot_be_retrieved_is_recorded_skipped_and_asked_for_again(self):
        corrupt_day = self.trading_dates[1]
        failures = {("quotes", corrupt_day, "*"): self.corrupt, ("quotes", corrupt_day, near_expiry(corrupt_day)): self.corrupt, ("quotes", corrupt_day, far_expiry(corrupt_day)): self.corrupt}
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date, failures=failures))
        self.assertEqual(exit_code, 0)
        self.assertEqual([event["lastDate"] for event in events[1:-1]], ["2024-03-25", "2024-03-27", "2024-03-28", "2024-03-29"])
        self.assertEqual(events[-1], {"type": "done", "daysDone": 4, "daysTotal": 5, "unavailableDays": 1, "daysWithIssues": 0})
        self.assertEqual([day[0] for day in self.stored_days()], ["2024-03-25", "2024-03-27", "2024-03-28", "2024-03-29"])
        unavailable_days = self.read_database("SELECT trading_date, attempts, reason FROM unavailable_days")
        self.assertEqual([day[:2] for day in unavailable_days], [("2024-03-26", 1)])
        self.assertRegex(unavailable_days[0][2], r"^quotes at 10:00: .*INTERNAL: Corrupt FIT data.*\(and 1 more expirations failed\)$")
        self.assert_every_stored_day_is_whole()

        retrying_service = FakeThetaData(self.frames_by_date, failures=failures)
        exit_code, events = self.run_downloader(retrying_service)
        self.assertEqual((exit_code, events[0], events[-1]), (0, {"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 4},
                                                           {"type": "done", "daysDone": 4, "daysTotal": 5, "unavailableDays": 1, "daysWithIssues": 0}))
        # Only the unavailable day is asked for again; the service check uses the latest stored day.
        self.assertEqual({trading_date for _, trading_date, _ in retrying_service.calls if trading_date}, {corrupt_day, self.trading_dates[3]})
        self.assertEqual(retrying_service.calls_for("quotes", self.trading_dates[3]), [near_expiry(self.trading_dates[3])])
        self.assertEqual(self.read_database("SELECT trading_date, attempts FROM unavailable_days"), [("2024-03-26", 2)])

        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)
        self.assertEqual(self.read_database("SELECT count(*) FROM unavailable_days"), [(0,)])

    def test_a_failing_service_stops_the_run_instead_of_marking_days(self):
        failing_day = self.trading_dates[1]
        # The first day is in the file before this run, so the service check asks again for its data.
        self.assertEqual(self.run_downloader(FakeThetaData(self.frames_by_date), end="2024-03-25")[0], 0)
        unavailable = FakeRpcError(grpc.StatusCode.UNAVAILABLE, "failed to connect to all addresses")
        service = FakeThetaData(self.frames_by_date, failures={("quotes", failing_day, "*"): unavailable,
                                                               ("quotes", self.trading_dates[0], near_expiry(self.trading_dates[0])): unavailable})
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("a request that worked before fails too", events[-1]["message"])
        self.assertIn("ThetaData is having a problem", events[-1]["message"])
        self.assertEqual(self.read_database("SELECT (SELECT count(*) FROM unavailable_days) + (SELECT count(*) FROM day_issues)"), [(0,)])
        self.assertEqual([day[0] for day in self.stored_days()], ["2024-03-25"])
        self.assertEqual(service.calls_for("quotes", failing_day), ["*"] * (len(NO_RETRY_DELAYS) + 1))
        self.assert_every_stored_day_is_whole()

    def test_before_anything_is_stored_the_service_is_checked_with_the_expirations_request(self):
        first_day = self.trading_dates[0]
        service = FakeThetaData(self.frames_by_date, failures={("quotes", first_day, "*"): self.corrupt})
        exit_code, events = self.run_downloader(service, end="2024-03-25")
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 1, "daysTotal": 1, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(len([call for call in service.calls if call[0] == "expirations"]), 2)
        self.assertEqual(self.stored_days(), [("2024-03-25",) + self.whole_day])

    def test_a_day_whose_end_of_day_cannot_be_retrieved_at_all_is_recorded_skipped_and_asked_for_again(self):
        corrupt_day = self.trading_dates[1]
        failures = {("eod", corrupt_day, "*"): self.corrupt, ("eod", corrupt_day, near_expiry(corrupt_day)): self.corrupt, ("eod", corrupt_day, far_expiry(corrupt_day)): self.corrupt}
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date, failures=failures))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 4, "daysTotal": 5, "unavailableDays": 1, "daysWithIssues": 0}))
        self.assertEqual([day[0] for day in self.stored_days()], ["2024-03-25", "2024-03-27", "2024-03-28", "2024-03-29"])
        unavailable_days = self.read_database("SELECT trading_date, attempts, reason FROM unavailable_days")
        self.assertEqual([day[:2] for day in unavailable_days], [("2024-03-26", 1)])
        self.assertRegex(unavailable_days[0][2], r"^end of day: .*INTERNAL: Corrupt FIT data.*\(and 1 more expirations failed\)$")
        self.assertEqual(self.read_database("SELECT count(*) FROM day_issues"), [(0,)])
        self.assert_every_stored_day_is_whole()

        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)
        self.assertEqual(self.read_database("SELECT count(*) FROM unavailable_days"), [(0,)])

    def test_a_part_that_cannot_be_retrieved_at_all_from_the_first_day_of_a_new_file_stops_the_run_on_the_third_day(self):
        failures = {("eod", trading_date, expiration): self.corrupt
                    for trading_date in self.trading_dates for expiration in ("*", near_expiry(trading_date), far_expiry(trading_date))}
        service = FakeThetaData(self.frames_by_date, failures=failures)
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("the end of day could not be retrieved at all on 3 days in a row (2024-03-25 to 2024-03-27) and the file holds none yet to check ThetaData with",
                      events[-1]["message"])
        self.assertIn("INTERNAL: Corrupt FIT data", events[-1]["message"])
        self.assertEqual(self.stored_days(), [])
        self.assertEqual(self.read_database("SELECT trading_date, attempts FROM unavailable_days ORDER BY trading_date"),
                         [("2024-03-25", 1), ("2024-03-26", 1), ("2024-03-27", 1)])
        self.assertEqual(self.read_database("SELECT count(*) FROM quotes"), [(0,)])

    def test_two_such_days_then_a_day_with_the_part_do_not_stop_the_run(self):
        failures = {("eod", trading_date, expiration): self.corrupt
                    for trading_date in self.trading_dates[:2] for expiration in ("*", near_expiry(trading_date), far_expiry(trading_date))}
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date, failures=failures))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 3, "daysTotal": 5, "unavailableDays": 2, "daysWithIssues": 0}))
        self.assertEqual([day[0] for day in self.stored_days()], ["2024-03-27", "2024-03-28", "2024-03-29"])

    def test_once_the_file_holds_the_part_a_day_without_it_is_checked_against_the_stored_data_however_many_follow(self):
        failures = {("eod", trading_date, expiration): self.corrupt
                    for trading_date in self.trading_dates[1:] for expiration in ("*", near_expiry(trading_date), far_expiry(trading_date))}
        service = FakeThetaData(self.frames_by_date, failures=failures)
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 2, "daysTotal": 5, "unavailableDays": 3, "daysWithIssues": 0}))
        # Each failing day's service check asked again for the first day's end of day, one expiration, or, when that day was
        # not stored yet (days are fetched ahead), for the expirations.
        stored_data_checks = service.calls_for("eod", self.trading_dates[0])[1:]
        self.assertEqual(set(stored_data_checks) - {near_expiry(self.trading_dates[0])}, set())
        expiration_checks = sum(1 for called_part, _, _ in service.calls if called_part == "expirations") - 1
        self.assertEqual(len(stored_data_checks) + expiration_checks, 3)

    def test_intraday_quotes_follow_the_same_rules(self):
        corrupt_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_by_date, failures={("intraday_quotes", corrupt_day, "*"): self.corrupt, ("intraday_quotes", corrupt_day, far_expiry(corrupt_day)): self.corrupt})
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 1}))
        self.assertEqual(self.stored_days()[1], ("2024-03-26", "complete", CONTRACTS_PER_DAY, CONTRACTS_PER_DAY, CONTRACTS_PER_DAY, "complete", 12, INTRADAY_ROWS_PER_DAY // 2))
        self.assertEqual(self.read_database("SELECT part, expiry FROM day_issues"), [("intraday_quotes", far_expiry(corrupt_day))])
        self.assert_service_checked_once(service, "intraday_quotes", self.trading_dates[0])
        self.assert_every_stored_day_is_whole()

    def test_a_day_whose_intraday_quotes_cannot_be_retrieved_keeps_its_morning_parts_and_is_asked_for_again(self):
        corrupt_day = self.trading_dates[1]
        failures = {("intraday_quotes", corrupt_day, expiration): self.corrupt for expiration in ("*", near_expiry(corrupt_day), far_expiry(corrupt_day))}
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date, failures=failures))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 4, "daysTotal": 5, "unavailableDays": 1, "daysWithIssues": 0}))
        self.assertEqual(self.stored_days()[1], ("2024-03-26", "complete", CONTRACTS_PER_DAY, CONTRACTS_PER_DAY, CONTRACTS_PER_DAY, None, None, None))
        unavailable_days = self.read_database("SELECT trading_date, attempts, reason FROM unavailable_days")
        self.assertEqual(unavailable_days[0][:2], ("2024-03-26", 1))
        self.assertTrue(unavailable_days[0][2].startswith("intraday quotes: "))
        self.assert_every_stored_day_is_whole()

        retrying_service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(retrying_service)
        self.assertEqual((exit_code, events[0]["daysDone"], events[-1]), (0, 4, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual([call for call in retrying_service.calls if call[0] != "expirations"], [("intraday_quotes", corrupt_day, "*")])
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)

    def test_a_permission_error_fails_at_once_and_keeps_only_whole_days(self):
        refused_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_by_date, failures={("eod", refused_day, "*"): [FakeRpcError(grpc.StatusCode.PERMISSION_DENIED, "not subscribed")]})
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("PERMISSION_DENIED", events[-1]["message"])
        self.assertEqual(service.calls_for("eod", refused_day), ["*"])
        self.assertEqual([day[0] for day in self.stored_days()], ["2024-03-25"])
        self.assert_every_stored_day_is_whole()

    def test_a_permission_error_while_asking_expiration_by_expiration_fails_at_once_too(self):
        corrupt_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_by_date, failures={("quotes", corrupt_day, "*"): self.corrupt,
                                                               ("quotes", corrupt_day, near_expiry(corrupt_day)): FakeRpcError(grpc.StatusCode.PERMISSION_DENIED, "not subscribed")})
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 1)
        self.assertIn("PERMISSION_DENIED", events[-1]["message"])
        self.assertEqual(self.read_database("SELECT (SELECT count(*) FROM unavailable_days) + (SELECT count(*) FROM day_issues)"), [(0,)])

    def test_rows_that_cannot_be_used_are_the_days_fault_and_the_run_goes_on(self):
        corrupt_day = self.trading_dates[1]
        self.frames_by_date[corrupt_day]["quotes"] = quote_frame(
            corrupt_day, [(expiry, "not a strike", right_word, bid, ask) for expiry, _, right_word, bid, ask in contracts_for_trading_day(corrupt_day)])
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 4, "daysTotal": 5, "unavailableDays": 1, "daysWithIssues": 0}))
        self.assertEqual([day[0] for day in self.stored_days()], ["2024-03-25", "2024-03-27", "2024-03-28", "2024-03-29"])
        unavailable_days = self.read_database("SELECT trading_date, reason FROM unavailable_days")
        self.assertEqual([day[0] for day in unavailable_days], ["2024-03-26"])
        self.assertRegex(unavailable_days[0][1], r"^quotes at 10:00: .* returned rows that cannot be used \(ValueError.*\(and 1 more expirations failed\)$")
        # The answer arrived, so it was not asked for again; each expiration was then asked for on its own.
        quote_calls = service.calls_for("quotes", corrupt_day)
        self.assertEqual(quote_calls.count("*"), 1)
        self.assertLessEqual({near_expiry(corrupt_day), far_expiry(corrupt_day)}, set(quote_calls))
        self.assert_every_stored_day_is_whole()

    def test_a_contract_answered_for_two_expirations_is_stored_once(self):
        corrupt_day = self.trading_dates[1]
        service = FakeThetaData(self.frames_by_date, failures={("quotes", corrupt_day, "*"): self.corrupt})
        service.ignores_the_expiration_asked_for = True
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertGreater(len([expiration_key for expiration_key in service.calls_for("quotes", corrupt_day) if expiration_key != "*"]), 1)
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)
        self.assert_every_stored_day_is_whole()

    def test_a_part_answered_with_no_data_on_a_day_that_has_data_is_recorded_and_logged_as_a_warning(self):
        day_without_end_of_day = self.trading_dates[1]
        del self.frames_by_date[day_without_end_of_day]["eod"]
        with self.assertLogs(downloader.logger, level="WARNING") as logged:
            exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 1}))
        self.assertEqual(self.stored_days()[1], ("2024-03-26", "complete", CONTRACTS_PER_DAY, 0, CONTRACTS_PER_DAY, "complete", 12, INTRADAY_ROWS_PER_DAY))
        self.assertEqual(self.read_database("SELECT trading_date, part, expiry, message, attempts FROM day_issues"), [("2024-03-26", "eod", None, "no data returned", 1)])
        day_warnings = [record.getMessage() for record in logged.records if record.getMessage().startswith("INTC 2024-03-26 ")]
        self.assertEqual(len(day_warnings), 1)
        self.assertRegex(day_warnings[0], r"^INTC 2024-03-26 complete: .* stored with a missing part: eod \(")
        # The holiday has no data in any part: nothing is missing from it.
        self.assertEqual(self.stored_days()[4], ("2024-03-29", "no_data", 0, 0, 0, None, None, None))

    # --- pieces left out of a stored day are asked for again on later runs

    def download_with_one_expiration_of_the_quotes_left_out(self):
        corrupt_day = self.trading_dates[1]
        failures = {("quotes", corrupt_day, "*"): self.corrupt, ("quotes", corrupt_day, far_expiry(corrupt_day)): self.corrupt}
        self.run_downloader(FakeThetaData(self.frames_by_date, failures=failures))
        self.assertEqual(self.read_database("SELECT part, expiry, attempts FROM day_issues"), [("quotes", far_expiry(corrupt_day), 1)])
        return corrupt_day, failures

    def test_a_piece_left_out_is_asked_for_again_on_the_next_run_and_stored(self):
        corrupt_day, _ = self.download_with_one_expiration_of_the_quotes_left_out()
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events), (0, [{"type": "start", "symbol": "INTC", "daysTotal": 5, "daysDone": 5},
                                                   {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}]))
        self.assertEqual((service.calls, service.login_count), ([("quotes", corrupt_day, far_expiry(corrupt_day))], 1))
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)
        self.assertEqual(self.read_database("SELECT count(*) FROM day_issues"), [(0,)])
        self.assert_every_stored_day_is_whole()

    def test_a_piece_that_keeps_failing_is_asked_for_on_three_later_runs_and_then_left(self):
        corrupt_day, failures = self.download_with_one_expiration_of_the_quotes_left_out()
        for later_run in (1, 2, 3):
            service = FakeThetaData(self.frames_by_date, failures=failures)
            exit_code, events = self.run_downloader(service)
            self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 1}))
            # Asked for once a run: ThetaData cannot read it, so it is not retried.
            self.assertEqual(service.calls_for("quotes", corrupt_day), [far_expiry(corrupt_day)])
            # The failure counted because ThetaData still answered for quotes already stored (the latest day's).
            self.assertEqual(service.calls_for("quotes", self.trading_dates[3]), [near_expiry(self.trading_dates[3])])
            self.assertEqual(self.read_database("SELECT attempts FROM day_issues"), [(1 + later_run,)])
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 1}))
        self.assertEqual((service.calls, service.login_count), ([], 0))
        self.assertEqual(self.stored_days()[1][2], CONTRACTS_PER_DAY // 2)

    def test_a_piece_asked_for_again_while_thetadata_is_failing_ends_the_run_without_counting_the_attempt(self):
        corrupt_day, failures = self.download_with_one_expiration_of_the_quotes_left_out()
        unavailable = FakeRpcError(grpc.StatusCode.UNAVAILABLE, "failed to connect to all addresses")
        service = FakeThetaData(self.frames_by_date, failures={("quotes", corrupt_day, far_expiry(corrupt_day)): unavailable,
                                                               ("quotes", self.trading_dates[3], near_expiry(self.trading_dates[3])): unavailable})
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 1)
        self.assertIn("a request that worked before fails too", events[-1]["message"])
        self.assertEqual(self.read_database("SELECT attempts FROM day_issues"), [(1,)])

    def test_an_expiration_left_out_that_now_answers_with_no_data_has_nothing_left_to_ask_for(self):
        corrupt_day, _ = self.download_with_one_expiration_of_the_quotes_left_out()
        near_expiry_only = [contract for contract in contracts_for_trading_day(corrupt_day) if contract[0] == near_expiry(corrupt_day)]
        self.frames_by_date[corrupt_day]["quotes"] = quote_frame(corrupt_day, near_expiry_only)
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(service.calls, [("quotes", corrupt_day, far_expiry(corrupt_day))])
        self.assertEqual(self.stored_days()[1][2], CONTRACTS_PER_DAY // 2)

    def test_a_recent_day_with_no_data_in_any_part_is_asked_for_again_until_it_is_seven_days_old(self):
        # Monday 1 April: Friday 29 March is the last finished session and is under 7 days old.
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date), now=eastern_time(2024, 4, 1, 12))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 4, "daysTotal": 5, "unavailableDays": 1, "daysWithIssues": 0}))
        self.assertEqual([day[0] for day in self.stored_days()], ["2024-03-25", "2024-03-26", "2024-03-27", "2024-03-28"])
        self.assertEqual(self.read_database("SELECT trading_date, attempts, reason FROM unavailable_days"), [("2024-03-29", 1, downloader.NOT_PUBLISHED_YET_REASON)])
        self.assert_every_stored_day_is_whole()

        # Still not published on Thursday 4 April (6 days old): asked for again, nothing else is.
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service, now=eastern_time(2024, 4, 4, 12))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 4, "daysTotal": 5, "unavailableDays": 1, "daysWithIssues": 0}))
        self.assertEqual(sorted({trading_date for _, trading_date, _ in service.calls if trading_date}), [self.holiday])
        self.assertEqual(self.read_database("SELECT attempts FROM unavailable_days"), [(2,)])

        # Friday 5 April (7 days old): no data is now final, a no_data day that is not asked for again.
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date), now=eastern_time(2024, 4, 5, 12))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(self.stored_days()[4], ("2024-03-29", "no_data", 0, 0, 0, None, None, None))
        self.assertEqual(self.read_database("SELECT count(*) FROM unavailable_days"), [(0,)])

    def test_a_recent_day_with_no_data_yet_is_stored_once_thetadata_publishes_it(self):
        self.run_downloader(FakeThetaData(self.frames_by_date), now=eastern_time(2024, 4, 1, 12))
        self.frames_by_date[self.holiday] = frames_for_trading_day(self.holiday)
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service, now=eastern_time(2024, 4, 2, 12))
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(sorted({trading_date for _, trading_date, _ in service.calls if trading_date}), [self.holiday])
        self.assertEqual(self.stored_days()[4], ("2024-03-29",) + self.whole_day)
        self.assertEqual(self.read_database("SELECT count(*) FROM unavailable_days"), [(0,)])
        self.assert_every_stored_day_is_whole()

    def test_a_part_answered_with_no_data_is_asked_for_again_and_stored_when_it_arrives(self):
        day_without_end_of_day = self.trading_dates[1]
        end_of_day_frame_of_the_day = self.frames_by_date[day_without_end_of_day].pop("eod")
        self.run_downloader(FakeThetaData(self.frames_by_date))
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 1}))
        self.assertEqual(service.calls, [("eod", day_without_end_of_day, "*")])
        self.assertEqual(self.read_database("SELECT part, expiry, message, attempts FROM day_issues"), [("eod", None, "no data returned", 2)])

        self.frames_by_date[day_without_end_of_day]["eod"] = end_of_day_frame_of_the_day
        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(service.calls, [("eod", day_without_end_of_day, "*")])
        self.assertEqual(self.stored_days()[1], ("2024-03-26",) + self.whole_day)
        self.assert_every_stored_day_is_whole()

    def test_intraday_quotes_asked_for_again_keep_the_strike_window_the_day_was_stored_with(self):
        corrupt_day = self.trading_dates[1]
        failures = {("intraday_quotes", corrupt_day, "*"): self.corrupt, ("intraday_quotes", corrupt_day, far_expiry(corrupt_day)): self.corrupt}
        self.run_downloader(FakeThetaData(self.frames_by_date, failures=failures), extra_arguments=("--intraday-strike-window-pct", "20"))
        self.assertEqual(self.read_database("SELECT part, expiry FROM day_issues"), [("intraday_quotes", far_expiry(corrupt_day))])
        rows_within_the_window_per_expiry = 3 * 2 * 12
        self.assertEqual(self.read_database("SELECT quote_rows FROM intraday_days WHERE trading_date = '2024-03-26'"), [(rows_within_the_window_per_expiry,)])

        service = FakeThetaData(self.frames_by_date)
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(service.calls, [("intraday_quotes", corrupt_day, far_expiry(corrupt_day))])
        self.assertEqual(self.read_database("SELECT status, look_count, quote_rows, strike_window_pct FROM intraday_days WHERE trading_date = '2024-03-26'"),
                         [("complete", 12, 2 * rows_within_the_window_per_expiry, 20.0)])
        self.assertEqual(self.read_database("SELECT DISTINCT strike FROM intraday_quotes WHERE trading_date = '2024-03-26' AND expiry = ? ORDER BY strike", (far_expiry(corrupt_day),)),
                         [(40.0,), (42.5,), (45.0,)])
        self.assert_every_stored_day_is_whole()

    # --- one login per API key at a time
    # --- one login per API key at a time

    def test_a_session_taken_by_another_login_is_logged_in_again_and_the_day_completed(self):
        service = FakeThetaData(self.frames_by_date)

        # During the first day, so later requests are still to be made (several days are fetched ahead) and find the session taken.
        def another_login_during_the_first_day(part_name, trading_date, expiration_key):
            if trading_date == self.trading_dates[0] and part_name == "eod" and service.login_count == 1:
                service.another_program_logs_in()

        service.on_request = another_login_during_the_first_day
        exit_code, events = self.run_downloader(service)
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 5, "daysTotal": 5, "unavailableDays": 0, "daysWithIssues": 0}))
        self.assertEqual(service.login_count, 2)
        self.assertEqual([day[1] for day in self.stored_days()], ["complete"] * 4 + ["no_data"])
        self.assertEqual(self.read_database("SELECT (SELECT count(*) FROM unavailable_days) + (SELECT count(*) FROM day_issues)"), [(0,)])
        self.assert_every_stored_day_is_whole()

    def test_a_session_that_keeps_being_taken_fails_after_five_new_logins(self):
        service = FakeThetaData(self.frames_by_date)
        service.every_login_is_taken_at_once = True
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1], {"type": "error", "message": "another ThetaData login keeps taking the session (5 new logins did not hold): only one program may use the API key at a time"})
        self.assertEqual(service.login_count, 1 + 5)

    def test_any_other_authentication_error_fails_at_once(self):
        service = FakeThetaData(self.frames_by_date, failures={("quotes", self.trading_dates[0], "*"): FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, "API key revoked")})
        exit_code, events = self.run_downloader(service)
        self.assertEqual(exit_code, 1)
        self.assertIn("UNAUTHENTICATED: API key revoked", events[-1]["message"])
        self.assertEqual((service.login_count, service.calls_for("quotes", self.trading_dates[0])), (1, ["*"]))

    # --- stopping, bad input

    def test_a_stop_request_ends_with_cancelled_and_no_half_written_day(self):
        stop_requested = threading.Event()

        def stop_on_third_day(part_name, trading_date, expiration_key):
            if trading_date == self.trading_dates[2] and part_name == "eod":
                stop_requested.set()

        service = FakeThetaData(self.frames_by_date, on_request=stop_on_third_day, call_duration_seconds=0.02)
        exit_code, events = self.run_downloader(service, stop_requested=stop_requested)
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1], {"type": "error", "message": "cancelled"})
        stored_dates = [day[0] for day in self.stored_days()]
        self.assertLess(len(stored_dates), 5)
        self.assertEqual(stored_dates, ["2024-03-25", "2024-03-26", "2024-03-27"][:len(stored_dates)])
        self.assertEqual({day[1:] for day in self.stored_days()}, {self.whole_day})
        self.assert_every_stored_day_is_whole()

    def test_a_symbol_without_options_fails_and_leaves_no_empty_file(self):
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date, has_options=False))
        self.assertEqual(exit_code, 1)
        self.assertEqual(events[-1], {"type": "error", "message": "ThetaData has no options for symbol INTC"})
        self.assertFalse((self.data_directory / "INTC.sqlite").exists())

    def test_a_failure_keeps_an_existing_file(self):
        self.run_downloader(FakeThetaData(self.frames_by_date), end="2024-03-25")
        refused = FakeRpcError(grpc.StatusCode.PERMISSION_DENIED, "not subscribed")
        exit_code, _ = self.run_downloader(FakeThetaData(self.frames_by_date, failures={("quotes", self.trading_dates[1], "*"): refused}))
        self.assertEqual(exit_code, 1)
        self.assertEqual([day[0] for day in self.stored_days()], ["2024-03-25"])

    def test_a_new_file_holding_only_an_unavailable_day_is_kept(self):
        first_day = self.trading_dates[0]
        failures = {("quotes", first_day, expiration): self.corrupt for expiration in ("*", near_expiry(first_day), far_expiry(first_day))}
        exit_code, events = self.run_downloader(FakeThetaData(self.frames_by_date, failures=failures), end="2024-03-25")
        self.assertEqual((exit_code, events[-1]), (0, {"type": "done", "daysDone": 0, "daysTotal": 1, "unavailableDays": 1, "daysWithIssues": 0}))
        self.assertEqual(self.read_database("SELECT trading_date, attempts FROM unavailable_days"), [("2024-03-25", 1)])

    def test_invalid_arguments_are_reported_as_an_error_line(self):
        def run_with(arguments):
            events = []
            return downloader.run_download(arguments, events.append, threading.Event(), lambda: None, NO_RETRY_DELAYS), events

        self.assertEqual(run_with(["--symbol", "INTC", "--start", "2024-03-29", "--end", "2024-03-25", "--data-dir", str(self.data_directory)]),
                         (1, [{"type": "error", "message": "--end 2024-03-25 is before --start 2024-03-29"}]))
        exit_code, events = run_with(["--symbol", "INTC"])
        self.assertEqual(exit_code, 1)
        self.assertTrue(events[-1]["message"].startswith("invalid arguments:"))
        exit_code, events = run_with(["--symbol", "INTC", "--start", "2024-03-25", "--end", "2024-03-25", "--data-dir", str(self.data_directory), "--intraday-strike-window-pct", "0"])
        self.assertEqual((exit_code, events[-1]["message"]), (1, "--intraday-strike-window-pct must be above 0: 0.0"))


if __name__ == "__main__":
    unittest.main()
