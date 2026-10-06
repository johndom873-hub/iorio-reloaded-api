import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyPlutoTelegram, notifyTelegram } from "./notifyTelegram.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => "" });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TELEGRAM_NOTIFICATIONS_DISABLED", "");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "ops-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "-100123");
  vi.stubEnv("PLUTO_TELEGRAM_BOT_TOKEN", "pluto-token");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("notifyPlutoTelegram", () => {
  it("sends through Pluto's own bot into the shared alerts group", async () => {
    expect(await notifyPlutoTelegram("Pluto sent an order")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botpluto-token/sendMessage");
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: "-100123", text: "Pluto sent an order" });
  });

  it("never falls back to the ops bot when Pluto's token is missing", async () => {
    vi.stubEnv("PLUTO_TELEGRAM_BOT_TOKEN", "");
    expect(await notifyPlutoTelegram("Pluto sent an order")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays silent when Telegram is disabled on purpose", async () => {
    vi.stubEnv("TELEGRAM_NOTIFICATIONS_DISABLED", "true");
    expect(await notifyPlutoTelegram("Pluto sent an order")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves every other alert on the ops bot", async () => {
    await notifyTelegram("Capture finished");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.telegram.org/botops-token/sendMessage");
  });
});
