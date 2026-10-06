import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLogsFromBetterStack } from "./betterstackService.js";

const fetchMock = vi.fn();

function respondWithRows(rows: { dt: string; raw: string }[]): void {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => rows.map((row) => JSON.stringify(row)).join("\n") + "\n" });
}

function sentRequest(): { url: string; headers: Record<string, string>; body: string } {
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, headers: init.headers, body: init.body };
}

const apiEnvironment = {
  BETTERSTACK_SQL_HOST: "api-sql.example.com",
  BETTERSTACK_SQL_USERNAME: "api-user",
  BETTERSTACK_SQL_PASSWORD: "api-pass",
  BETTERSTACK_SOURCE_TABLE: "t1_api",
};
const appEnvironment = {
  BETTERSTACK_APP_SQL_HOST: "app-sql.example.com",
  BETTERSTACK_APP_SQL_USERNAME: "app-user",
  BETTERSTACK_APP_SQL_PASSWORD: "app-pass",
  BETTERSTACK_APP_SOURCE_TABLE: "t2_app",
};

describe("fetchLogsFromBetterStack", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    for (const [name, value] of Object.entries({ ...apiEnvironment, ...appEnvironment })) vi.stubEnv(name, value);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("credentials per app", () => {
    it("uses the api credentials, host and source table for the api app", async () => {
      respondWithRows([]);
      await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 10 });
      const request = sentRequest();
      expect(request.url).toBe("https://api-sql.example.com?output_format_pretty_row_numbers=0");
      expect(request.headers.Authorization).toBe(`Basic ${Buffer.from("api-user:api-pass").toString("base64")}`);
      expect(request.body).toContain("remote(t1_api_logs)");
      expect(request.body).toContain("s3Cluster(primary, t1_api_s3)");
    });

    it("uses the separate app credentials, host and source table for the app app", async () => {
      respondWithRows([]);
      await fetchLogsFromBetterStack({ sourceApp: "app", minutes: 10 });
      const request = sentRequest();
      expect(request.url).toBe("https://app-sql.example.com?output_format_pretty_row_numbers=0");
      expect(request.headers.Authorization).toBe(`Basic ${Buffer.from("app-user:app-pass").toString("base64")}`);
      expect(request.body).toContain("remote(t2_app_logs)");
    });

    it.each(Object.keys(apiEnvironment))("fails closed naming %s when it is missing for the api app", async (name) => {
      vi.stubEnv(name, "");
      await expect(fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).rejects.toThrow(`Missing required environment variable: ${name}`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(Object.keys(appEnvironment))("fails closed naming %s when it is missing for the app app", async (name) => {
      vi.stubEnv(name, "");
      await expect(fetchLogsFromBetterStack({ sourceApp: "app", minutes: 1 })).rejects.toThrow(`Missing required environment variable: ${name}`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not need the other app's credentials", async () => {
      for (const name of Object.keys(appEnvironment)) vi.stubEnv(name, "");
      respondWithRows([]);
      await expect(fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).resolves.toBe("");
    });
  });

  describe("query construction", () => {
    it("defaults to the last 30 minutes", async () => {
      respondWithRows([]);
      await fetchLogsFromBetterStack({ sourceApp: "api" });
      expect(sentRequest().body).toContain("dt >= now() - INTERVAL 30 MINUTE");
    });

    it("rounds a fractional number of minutes up", async () => {
      respondWithRows([]);
      await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 10.2 });
      expect(sentRequest().body).toContain("INTERVAL 11 MINUTE");
    });

    it("applies the same condition to the hot and the cold storage and limits the unioned result", async () => {
      respondWithRows([]);
      await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 5 });
      const body = sentRequest().body;
      expect(body.match(/dt >= now\(\) - INTERVAL 5 MINUTE/g)).toHaveLength(2);
      expect(body).toContain("_row_type = 1 AND dt >= now()");
      expect(body).toContain("ORDER BY dt DESC");
      expect(body).toContain("LIMIT 5000");
      expect(body).toContain("FORMAT JSONEachRow");
    });

    it("rebuilds an absolute window from parsed dates, in UTC with millisecond precision", async () => {
      respondWithRows([]);
      await fetchLogsFromBetterStack({ sourceApp: "api", startTime: "2026-10-01T10:00:00Z", endTime: "2026-10-01T12:30:15.123Z" });
      const body = sentRequest().body;
      expect(body.match(/dt BETWEEN toDateTime64\('2026-10-01 10:00:00.000', 3, 'UTC'\) AND toDateTime64\('2026-10-01 12:30:15.123', 3, 'UTC'\)/g)).toHaveLength(2);
    });

    it("converts a time zone offset to UTC", async () => {
      respondWithRows([]);
      await fetchLogsFromBetterStack({ sourceApp: "api", startTime: "2026-10-01T10:00:00-04:00", endTime: "2026-10-01T11:00:00-04:00" });
      expect(sentRequest().body).toContain("toDateTime64('2026-10-01 14:00:00.000', 3, 'UTC')");
    });

    it("rejects an unparseable time instead of putting it in the SQL", async () => {
      await expect(fetchLogsFromBetterStack({ sourceApp: "api", startTime: "'; DROP TABLE x; --", endTime: "2026-10-01T12:00:00Z" })).rejects.toThrow("Invalid date/time: '; DROP TABLE x; --");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falls back to the relative window when only one end of the absolute range is given", async () => {
      respondWithRows([]);
      await fetchLogsFromBetterStack({ sourceApp: "api", startTime: "2026-10-01T10:00:00Z", minutes: 7 });
      const body = sentRequest().body;
      expect(body).toContain("INTERVAL 7 MINUTE");
      expect(body).not.toContain("BETWEEN");
    });
  });

  describe("response handling", () => {
    it("throws on a non-OK HTTP status", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "" });
      await expect(fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).rejects.toThrow("Better Stack SQL API HTTP 401");
    });

    it("returns an empty string for an empty body", async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" });
      await expect(fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).resolves.toBe("");
    });

    it("reverses the newest-first rows into chronological order and prefixes each line with its timestamp", async () => {
      respondWithRows([
        { dt: "2026-10-01 10:00:03.000", raw: JSON.stringify({ message: "third" }) },
        { dt: "2026-10-01 10:00:02.000", raw: JSON.stringify({ message: "second" }) },
        { dt: "2026-10-01 10:00:01.000", raw: JSON.stringify({ message: "first" }) },
      ]);
      expect(await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).toBe(
        ["2026-10-01 10:00:01.000 first", "2026-10-01 10:00:02.000 second", "2026-10-01 10:00:03.000 third"].join("\n"),
      );
    });

    it("uses the raw text when it is not JSON", async () => {
      respondWithRows([{ dt: "2026-10-01 10:00:00.000", raw: "plain heroku line" }]);
      expect(await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).toBe("2026-10-01 10:00:00.000 plain heroku line");
    });

    it("uses the raw text when the JSON has no message field, or the JSON is a bare scalar", async () => {
      respondWithRows([
        { dt: "2026-10-01 10:00:02.000", raw: "42" },
        { dt: "2026-10-01 10:00:01.000", raw: '{"level":"info"}' },
      ]);
      // "42" parses to a number, whose .message is undefined, so the raw text stays.
      expect(await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).toBe(['2026-10-01 10:00:01.000 {"level":"info"}', "2026-10-01 10:00:02.000 42"].join("\n"));
    });

    it("keeps an empty-string message as empty rather than the raw JSON", async () => {
      respondWithRows([{ dt: "2026-10-01 10:00:00.000", raw: JSON.stringify({ message: "" }) }]);
      expect(await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).toBe("2026-10-01 10:00:00.000 ");
    });

    it("drops duplicate lines that appear in both hot and cold storage, keeping distinct messages at the same time", async () => {
      respondWithRows([
        { dt: "2026-10-01 10:00:01.000", raw: JSON.stringify({ message: "same" }) },
        { dt: "2026-10-01 10:00:01.000", raw: JSON.stringify({ message: "same" }) },
        { dt: "2026-10-01 10:00:01.000", raw: JSON.stringify({ message: "other" }) },
        { dt: "2026-10-01 10:00:02.000", raw: JSON.stringify({ message: "same" }) },
      ]);
      expect((await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).split("\n")).toEqual([
        "2026-10-01 10:00:02.000 same",
        "2026-10-01 10:00:01.000 other",
        "2026-10-01 10:00:01.000 same",
      ]);
    });

    it("treats a JSON message and an identical plain raw line as duplicates", async () => {
      respondWithRows([
        { dt: "2026-10-01 10:00:01.000", raw: JSON.stringify({ message: "boot" }) },
        { dt: "2026-10-01 10:00:01.000", raw: "boot" },
      ]);
      expect(await fetchLogsFromBetterStack({ sourceApp: "api", minutes: 1 })).toBe("2026-10-01 10:00:01.000 boot");
    });
  });
});
