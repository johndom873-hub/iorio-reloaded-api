"""Schema 4 slices of the backtest data files (docs/backtesting/DATA-FILES.md): a day's option rows stored one SQLite row
per day, look and expiry, the contracts packed as columns in strike order (the Call before the Put), each column in the
narrowest width its values need within the slice. The same bytes as src/backtest/engine/symbolFileSlices.ts, which the
engine reads them with (test_symbol_file_slices.py holds bytes that module wrote).

A slice (little-endian): u32 contract count, then each column in order:
- the right: a bitmap (bit set = Put), padded to 4 bytes;
- a number: a descriptor byte (bits 0-2 the width: 0 none, every value = base; 1 u8; 2 u16; 3 i32; 4 the stored numbers
  as f64, NaN for None; bit 3 a null bitmap follows; bit 4 stored as the difference from the column before it), 3
  padding bytes, i32 base, i32 step, [the null bitmap padded to 4], then the values, padded to 4 bytes (f64 starts on
  8). A value = base + stored x step [+ the column before's value], in the column's unit: thousandths of a dollar for
  strikes, cents for prices, counts for sizes, volumes, open interest and milliseconds."""

import datetime
import math
import struct
import zoneinfo

TEN_O_CLOCK_LOOK_MINUTE = 600
"""The 10:00 look, in minutes after midnight Eastern: the 10:00 quotes' keys and the intraday look at 10:00."""
DAILY_SLICE_LOOK_MINUTE = 0
"""The look minute of the end-of-day and open-interest slices' keys."""

STRIKE, RIGHT, CENTS, CENTS_OVER_PREVIOUS, COUNT = "strike", "right", "cents", "centsOverPrevious", "count"
TEN_O_CLOCK_QUOTE_COLUMNS = (STRIKE, RIGHT, CENTS, CENTS_OVER_PREVIOUS, COUNT, COUNT, COUNT)
"""Strike, right, bid, ask, bid size, ask size, and the milliseconds from the quote's own time to 10:00 (quoted_at)."""
INTRADAY_QUOTE_COLUMNS = (STRIKE, RIGHT, CENTS, CENTS_OVER_PREVIOUS, COUNT, COUNT)
END_OF_DAY_COLUMNS = (STRIKE, RIGHT, CENTS, COUNT, CENTS, CENTS_OVER_PREVIOUS)
OPEN_INTEREST_COLUMNS = (STRIKE, RIGHT, COUNT)

SLICE_TABLES_SQL = (
    "CREATE TABLE IF NOT EXISTS ten_oclock_quote_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL, has_ask_above_zero INTEGER NOT NULL, data BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS intraday_quote_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL, data BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS end_of_day_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL, has_volume INTEGER NOT NULL, data BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS open_interest_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL, data BLOB NOT NULL)",
)

_UNIT = {STRIKE: 1000, CENTS: 100, CENTS_OVER_PREVIOUS: 100, COUNT: 1}
_WIDTH_BYTES = (0, 1, 2, 4, 8)
_INT32_MIN, _INT32_MAX = -2147483648, 2147483647
_EASTERN = zoneinfo.ZoneInfo("America/New_York")
_EPOCH = datetime.date(1970, 1, 1)


def slice_key(day_number: int, look_minute: int, days_to_expiry: int) -> int:
    """The trading day (days since 1970-01-01), the look's minute and the calendar days from the trading day to the expiry."""
    return day_number * 4294967296 + look_minute * 65536 + days_to_expiry


def day_number_of(date: datetime.date) -> int:
    return (date - _EPOCH).days


def date_of_day_number(day_number: int) -> datetime.date:
    return _EPOCH + datetime.timedelta(days=day_number)


def day_number_of_key(key: int) -> int:
    return key // 4294967296


def look_minute_of_key(key: int) -> int:
    return (key // 65536) % 65536


def days_to_expiry_of_key(key: int) -> int:
    return key % 65536


def look_minute_of(look_time: str) -> int:
    """The minute of an "HH:MM" Eastern look time."""
    return int(look_time[0:2]) * 60 + int(look_time[3:5])


def look_time_of_minute(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def _ten_o_clock_utc(trading_date: datetime.date) -> datetime.datetime:
    """10:00 Eastern on the trading date as a UTC instant: arithmetic on a zoneinfo time moves its wall clock, not the instant."""
    return datetime.datetime.combine(trading_date, datetime.time(10, 0), tzinfo=_EASTERN).astimezone(datetime.timezone.utc)


def milliseconds_before_ten_o_clock(trading_date: datetime.date, quoted_at_text: str) -> int:
    """Milliseconds from a quote's own time (ISO with offset, as format_quote_timestamp writes it) to 10:00:00 Eastern on
    the trading date: what a 10:00 slice keeps of quoted_at."""
    return (_ten_o_clock_utc(trading_date) - datetime.datetime.fromisoformat(quoted_at_text).astimezone(datetime.timezone.utc)) // datetime.timedelta(milliseconds=1)


def quoted_at_text_of(trading_date: datetime.date, milliseconds_before_ten: int) -> str:
    """The quote's own time back as format_quote_timestamp writes it, from a 10:00 slice's milliseconds before 10:00."""
    return (_ten_o_clock_utc(trading_date) - datetime.timedelta(milliseconds=milliseconds_before_ten)).astimezone(_EASTERN).isoformat(timespec="milliseconds")


def _padded_to(byte_count: int, alignment: int) -> int:
    return -(-byte_count // alignment) * alignment


def _bitmap_bytes(count: int) -> int:
    return _padded_to(-(-count // 8), 4)


def _javascript_round(value: float) -> int:
    """Math.round, as the TypeScript side rounds (halves up), so both sides choose the same encoding."""
    return math.floor(value + 0.5)


def pack_slice(rows: list[tuple], kinds: tuple[str, ...]) -> bytes:
    """Packs contracts (in strike order, the Call before the Put; the right as 'C' or 'P', the other values numbers or
    None) into a slice's bytes."""
    count = len(rows)
    parts = [struct.pack("<I", count)]
    size = 4
    previous_units = None
    for column, kind in enumerate(kinds):
        if kind == RIGHT:
            bitmap = bytearray(_bitmap_bytes(count))
            for index, row in enumerate(rows):
                if row[column] == "P":
                    bitmap[index >> 3] |= 1 << (index & 7)
                elif row[column] != "C":
                    raise ValueError(f"right {row[column]!r}")
            parts.append(bytes(bitmap))
            size += len(bitmap)
            previous_units = None
            continue
        unit = _UNIT[kind]
        units = [0] * count
        nulls = bytearray(_bitmap_bytes(count))
        has_nulls = False
        exact = True
        for index, row in enumerate(rows):
            value = row[column]
            if value is None:
                has_nulls = True
                nulls[index >> 3] |= 1 << (index & 7)
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"column {column}: {type(value).__name__}")
            scaled = _javascript_round(value * unit)
            if scaled / unit != value or scaled <= _INT32_MIN or scaled > _INT32_MAX:
                exact = False
            units[index] = scaled
        if not exact:
            padding = _padded_to(size + 12, 8) - (size + 12)
            parts.append(bytes([4]) + bytes(11) + bytes(padding))
            parts.append(b"".join(struct.pack("<d", math.nan if row[column] is None else float(row[column])) for row in rows))
            size += 12 + padding + 8 * count
            previous_units = None
            continue
        stored = units
        over_previous = False
        if kind == CENTS_OVER_PREVIOUS and previous_units is not None and all(row[column] is None or row[column - 1] is not None for row in rows):
            stored = [0 if rows[index][column] is None else units[index] - previous_units[index] for index in range(count)]
            over_previous = True
        present = [stored[index] for index in range(count) if rows[index][column] is not None]
        minimum = min(present) if present else 0
        maximum = max(present) if present else 0
        step = 1
        if kind == STRIKE:
            step = 0
            for value in present:
                step = math.gcd(step, value - minimum)
            if step == 0:
                step = 1
        value_range = (maximum - minimum) // step
        width_code = 0 if value_range == 0 else 1 if value_range <= 0xFF else 2 if value_range <= 0xFFFF else 3
        parts.append(struct.pack("<B3xii", width_code | (8 if has_nulls else 0) | (16 if over_previous else 0), minimum, step))
        size += 12
        if has_nulls:
            parts.append(bytes(nulls))
            size += len(nulls)
        if width_code > 0:
            fmt = {1: "B", 2: "H", 3: "i"}[width_code]
            values = struct.pack(f"<{count}{fmt}", *[0 if rows[index][column] is None else (stored[index] - minimum) // step for index in range(count)])
            padded = values + bytes(_padded_to(len(values), 4) - len(values))
            parts.append(padded)
            size += len(padded)
        previous_units = units
    return b"".join(parts)


def unpack_slice(data: bytes, kinds: tuple[str, ...]) -> list[tuple]:
    """A slice's contracts as rows in the columns' order: the right as 'C' or 'P', the values in dollars or counts, or None."""
    (count,) = struct.unpack_from("<I", data, 0)
    offset = 4
    bitmap_bytes = _bitmap_bytes(count)
    columns = []
    previous_units = None
    for column, kind in enumerate(kinds):
        if kind == RIGHT:
            columns.append(["P" if (data[offset + (index >> 3)] >> (index & 7)) & 1 else "C" for index in range(count)])
            offset += bitmap_bytes
            previous_units = None
            continue
        descriptor = data[offset]
        width_code = descriptor & 7
        if width_code == 4:
            offset = _padded_to(offset + 12, 8)
            values = struct.unpack_from(f"<{count}d", data, offset)
            columns.append([None if math.isnan(value) else value for value in values])
            offset += 8 * count
            previous_units = None
            continue
        base, step = struct.unpack_from("<ii", data, offset + 4)
        offset += 12
        null_bits = None
        if descriptor & 8:
            null_bits = data[offset:offset + bitmap_bytes]
            offset += bitmap_bytes
        stored = [0] * count
        if width_code > 0:
            stored = list(struct.unpack_from(f"<{count}{ {1: 'B', 2: 'H', 3: 'i'}[width_code] }", data, offset))
            offset += _padded_to(count * _WIDTH_BYTES[width_code], 4)
        over_previous = bool(descriptor & 16)
        unit = _UNIT[kind]
        units = [0] * count
        values = []
        for index in range(count):
            if null_bits is not None and (null_bits[index >> 3] >> (index & 7)) & 1:
                values.append(None)
                continue
            value = base + stored[index] * step + (previous_units[index] if over_previous else 0)
            units[index] = value
            values.append(value if unit == 1 else value / unit)
        columns.append(values)
        previous_units = units
    return [tuple(column[index] for column in columns) for index in range(count)]


def slice_counts(rows: list[tuple]) -> tuple[int, int]:
    """(Calls, Puts) of a slice's rows."""
    calls = sum(1 for row in rows if row[1] == "C")
    return calls, len(rows) - calls
