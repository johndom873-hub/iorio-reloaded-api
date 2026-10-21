import { describe, expect, it } from "vitest";
import { noticeLadderBook, noticeLadderTicker, type LadderNoticeDependencies } from "./ladderNotices.js";

/** Today's event log in memory: what was recorded, by key and Eastern date. */
function memoryLog(): LadderNoticeDependencies & { sent: string[]; recorded: { key: string; symbol: string | null }[] } {
  const keys = new Set<string>();
  const sent: string[] = [];
  const recorded: { key: string; symbol: string | null }[] = [];
  let today = "";
  return {
    sent,
    recorded,
    sentToday: async (key, todayIso) => ((today = todayIso), keys.has(`${todayIso}|${key}`)),
    record: async (key, symbol) => void (keys.add(`${today}|${key}`), recorded.push({ key, symbol })),
    send: async (text) => void sent.push(text),
  };
}

const morning = new Date("2026-10-21T14:00:00Z");
const afternoon = new Date("2026-10-21T19:00:00Z");
const nextDay = new Date("2026-10-22T14:00:00Z");

describe("ladder notices", () => {
  it("sends a ticker's notice once a day per reason, the text free of figures", async () => {
    const log = memoryLog();
    expect(await noticeLadderTicker("SMCI", "stale_band_quotes", { telegramVerbosity: "actions" }, morning, log)).toBe(true);
    expect(await noticeLadderTicker("SMCI", "stale_band_quotes", { telegramVerbosity: "actions" }, afternoon, log)).toBe(false);
    expect(await noticeLadderTicker("SMCI", "held_by_ticker_cap", { telegramVerbosity: "actions" }, afternoon, log)).toBe(true);
    expect(await noticeLadderTicker("HOOD", "stale_band_quotes", { telegramVerbosity: "actions" }, afternoon, log)).toBe(true);
    expect(await noticeLadderTicker("SMCI", "stale_band_quotes", { telegramVerbosity: "actions" }, nextDay, log)).toBe(true);
    expect(log.sent).toHaveLength(4);
    expect(log.sent[0]).toBe("⚠️ Pluto (CC + Put Ladder): SMCI can't trade for now: the ladder band's latest quotes are older than Pluto's quote-age limit.");
    expect(log.sent.every((text) => !/\d/.test(text))).toBe(true);
    expect(log.recorded[0]).toEqual({ key: "stale_band_quotes:SMCI", symbol: "SMCI" });
  });

  it("sends a book-wide limit's notice once a day, and records but does not send with Telegram off", async () => {
    const log = memoryLog();
    expect(await noticeLadderBook("book_committed_capital", { telegramVerbosity: "off" }, morning, log)).toBe(true);
    expect(await noticeLadderBook("book_committed_capital", { telegramVerbosity: "actions" }, afternoon, log)).toBe(false);
    expect(log.sent).toEqual([]);
    expect(log.recorded).toEqual([{ key: "book_committed_capital", symbol: null }]);
  });
});
