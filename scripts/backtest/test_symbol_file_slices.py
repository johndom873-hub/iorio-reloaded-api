import datetime
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import symbol_file_slices as slices  # noqa: E402

# Bytes src/backtest/engine/symbolFileSlices.ts's packSlice wrote for these rows (2026-10-29): the engine reads what the
# downloader writes only if both sides pack the same bytes.
SLICES_WRITTEN_BY_THE_ENGINE = {
    "tenOClock": (slices.TEN_O_CLOCK_QUOTE_COLUMNS, [
            (100, 'C', 1.25, 1.3, 10, 12, 1500),
            (100, 'P', None, 0.05, None, 3, None),
            (102.5, 'C', 0, 0, 0, 0, 0),
            (105, 'P', 655.36, 700.01, 70000, 65536, 3000000000),
            (1000.125, 'C', 2, 1.5, 1, 1, 0),
        ],
        "0500000002000000a08601007d0000000000000014002800211c00000a0000000b0000000000000001000000020000007d000000000000000000000000000100c800000003000000000000000100000082000000050000000000000071110100960000000b0000000000000001000000020000000a000000000000000000000070110100010000000300000000000000010000000c00000003000000000000000000010001000000040000000000000000000000000000000000000000709740000000000000f87f0000000000000000000000c00b5ae6410000000000000000"),
    "tenOClockHalfCent": (slices.TEN_O_CLOCK_QUOTE_COLUMNS, [
            (50, 'C', 0.015, 1, 5, 5, 0),
            (55, 'P', 0.02, 1.01, 5, 5, 0),
        ],
        "020000000100000050c3000088130000000100000200000004000000000000000000000000000000b81e85eb51b88e3f7b14ae47e17a943f01000000640000000100000000010000000000000500000001000000000000000500000001000000000000000000000001000000"),
    "intraday": (slices.INTRADAY_QUOTE_COLUMNS, [
            (95, 'C', 6.1, 6.35, 20, 25),
            (95, 'P', 0.9, 1, 40, 1),
            (97.5, 'C', 4.2, 4.45, 3, 300),
            (97.5, 'P', 1.6, 1.75, 0, 7),
        ],
        "040000000100000018730100c4090000000001010a000000020000005a00000001000000080200004a014600110000000a000000010000000f000f0501000000000000000100000014280300020000000100000001000000180000002b010600"),
    "endOfDay": (slices.END_OF_DAY_COLUMNS, [
            (95, 'C', None, None, 6.05, 6.3),
            (95, 'P', 0.95, 1200, 0.9, 1),
            (97.5, 'C', 4.3, 15, 4.25, 4.4),
        ],
        "030000000100000018730100c409000000000100020000000a0000005f0000000100000001000000000000004f0100000a0000000f00000001000000010000000000a10400000000020000005a00000001000000030200004f010000110000000a000000010000000f000500"),
    "openInterest": (slices.OPEN_INTEREST_COLUMNS, [
            (95, 'C', 1500),
            (95, 'P', 230),
            (97.5, 'C', 0),
        ],
        "030000000100000018730100c40900000000010002000000020000000000000001000000dc05e60000000000"),
}


class SliceTests(unittest.TestCase):
    def test_packs_the_bytes_the_engine_packs(self):
        for name, (kinds, rows, expected_hex) in SLICES_WRITTEN_BY_THE_ENGINE.items():
            with self.subTest(name):
                self.assertEqual(slices.pack_slice(rows, kinds).hex(), expected_hex)

    def test_reads_back_every_value(self):
        for name, (kinds, rows, expected_hex) in SLICES_WRITTEN_BY_THE_ENGINE.items():
            with self.subTest(name):
                self.assertEqual(slices.unpack_slice(bytes.fromhex(expected_hex), kinds), [tuple(row) for row in rows])

    def test_refuses_a_right_other_than_c_or_p(self):
        with self.assertRaisesRegex(ValueError, "right 'X'"):
            slices.pack_slice([(50, "X", 1, 1, 5, 5)], slices.INTRADAY_QUOTE_COLUMNS)

    def test_keys(self):
        key = slices.slice_key(slices.day_number_of(datetime.date(2026, 3, 2)), 630, 11)
        self.assertEqual((slices.date_of_day_number(slices.day_number_of_key(key)), slices.look_minute_of_key(key), slices.days_to_expiry_of_key(key)), (datetime.date(2026, 3, 2), 630, 11))
        self.assertEqual((slices.look_minute_of("15:30"), slices.look_time_of_minute(930)), (930, "15:30"))

    def test_keeps_the_quote_time_to_the_millisecond(self):
        for trading_date, quoted_at in ((datetime.date(2025, 1, 2), "2025-01-02T09:59:59.167-05:00"), (datetime.date(2026, 3, 9), "2026-03-06T15:59:59.000-05:00"),
                                        (datetime.date(2026, 10, 16), "2026-10-16T09:59:59.984-04:00")):
            milliseconds = slices.milliseconds_before_ten_o_clock(trading_date, quoted_at)
            self.assertEqual(slices.quoted_at_text_of(trading_date, milliseconds), quoted_at)
        self.assertEqual(slices.milliseconds_before_ten_o_clock(datetime.date(2025, 1, 2), "2025-01-02T09:59:59.167-05:00"), 833)


if __name__ == "__main__":
    unittest.main()
