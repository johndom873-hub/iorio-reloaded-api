import { describe, expect, it } from "vitest";
import { describeDownloadGaps, parseDownloaderLine } from "./thetaDataDownloaderProtocol.js";

describe("parseDownloaderLine", () => {
  it("reads the four events of DATA-FILES.md", () => {
    expect(parseDownloaderLine('{"type":"start","symbol":"AAOI","daysTotal":1700,"daysDone":1200}')).toEqual({ type: "start", symbol: "AAOI", daysTotal: 1700, daysDone: 1200 });
    expect(parseDownloaderLine('{"type":"progress","daysDone":1201,"daysTotal":1700,"lastDate":"2024-03-15","quoteRows":1100}')).toEqual({
      type: "progress",
      daysDone: 1201,
      daysTotal: 1700,
      lastDate: "2024-03-15",
      quoteRows: 1100,
    });
    expect(parseDownloaderLine('{"type":"done","daysDone":1698,"daysTotal":1700,"unavailableDays":2,"daysWithIssues":3}')).toEqual({
      type: "done",
      daysDone: 1698,
      daysTotal: 1700,
      unavailableDays: 2,
      daysWithIssues: 3,
    });
    expect(parseDownloaderLine('{"type":"error","message":"ThetaData refused the key"}')).toEqual({ type: "error", message: "ThetaData refused the key" });
  });

  it("reads a done line from a downloader that does not report unavailable days or gaps as none of either", () => {
    expect(parseDownloaderLine('{"type":"done","daysDone":1700,"daysTotal":1700}')).toEqual({ type: "done", daysDone: 1700, daysTotal: 1700, unavailableDays: 0, daysWithIssues: 0 });
    expect(parseDownloaderLine('{"type":"done","daysDone":1700,"daysTotal":1700,"unavailableDays":"2","daysWithIssues":-1}')).toEqual({
      type: "done",
      daysDone: 1700,
      daysTotal: 1700,
      unavailableDays: 0,
      daysWithIssues: 0,
    });
  });

  it("gives an error event without a message a readable one", () => {
    expect(parseDownloaderLine('{"type":"error"}')).toEqual({ type: "error", message: "The downloader reported an error without a message." });
  });

  it("returns null for anything that is not an event", () => {
    expect(parseDownloaderLine("Fetching 2024-03-15")).toBeNull();
    expect(parseDownloaderLine('{"type":"progress","daysDone":"12"}')).toBeNull();
    expect(parseDownloaderLine('{"type":"unknown"}')).toBeNull();
    expect(parseDownloaderLine("null")).toBeNull();
  });
});

describe("describeDownloadGaps", () => {
  it("is empty when every day was stored in full", () => {
    expect(describeDownloadGaps({ unavailableDays: 0, daysWithIssues: 0 })).toBe("");
  });
  it("names the days that could not be retrieved and the days stored with gaps", () => {
    expect(describeDownloadGaps({ unavailableDays: 2, daysWithIssues: 0 })).toBe(" · 2 days unavailable");
    expect(describeDownloadGaps({ unavailableDays: 0, daysWithIssues: 1 })).toBe(" · 1 day with gaps");
    expect(describeDownloadGaps({ unavailableDays: 1, daysWithIssues: 3 })).toBe(" · 1 day unavailable · 3 days with gaps");
  });
});
