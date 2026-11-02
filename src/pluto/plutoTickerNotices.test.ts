import { describe, expect, it } from "vitest";
import { noticePlutoTicker, type PlutoNoticeDependencies } from "./plutoTickerNotices.js";

/** Today's event log in memory: what was recorded, by key and Eastern date. */
function memoryLog(): PlutoNoticeDependencies & { sent: string[]; recorded: { key: string; symbol: string }[] } {
  const keys = new Set<string>();
  const sent: string[] = [];
  const recorded: { key: string; symbol: string }[] = [];
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

describe("Pluto's ticker notices", () => {
  it("sends a ticker's notice once a day per reason, the text free of figures", async () => {
    const log = memoryLog();
    expect(await noticePlutoTicker("SMCI", "split_guard", { telegramVerbosity: "actions" }, morning, log)).toBe(true);
    expect(await noticePlutoTicker("SMCI", "split_guard", { telegramVerbosity: "actions" }, afternoon, log)).toBe(false);
    expect(await noticePlutoTicker("HOOD", "split_guard", { telegramVerbosity: "actions" }, afternoon, log)).toBe(true);
    expect(await noticePlutoTicker("SMCI", "split_guard", { telegramVerbosity: "actions" }, nextDay, log)).toBe(true);
    expect(log.sent).toHaveLength(3);
    expect(log.sent[0]).toBe("⚠️ Pluto: SMCI is stopped: its price is about a split's factor away from the previous close with no split recorded. A person needs to look.");
    expect(log.sent.every((text) => !/\d/.test(text))).toBe(true);
    expect(log.recorded[0]).toEqual({ key: "split_guard:SMCI", symbol: "SMCI" });
  });

  it("records but does not send with Telegram off", async () => {
    const log = memoryLog();
    expect(await noticePlutoTicker("SMCI", "split_guard", { telegramVerbosity: "off" }, morning, log)).toBe(true);
    expect(log.sent).toEqual([]);
    expect(log.recorded).toEqual([{ key: "split_guard:SMCI", symbol: "SMCI" }]);
  });
});
