import { describe, expect, it } from "vitest";
import { prefixWithQuotedMessage } from "./bot.js";

describe("prefixWithQuotedMessage", () => {
  it("passes the question through when it replies to nothing", () => {
    expect(prefixWithQuotedMessage("ready", undefined)).toBe("ready");
  });

  it("gives the model the alert a short reply refers to", () => {
    const message = prefixWithQuotedMessage("ready", "IBKR live Gateway is not logged in and needs a manual login");
    expect(message).toContain('[Replying to this message: "IBKR live Gateway is not logged in');
    expect(message.endsWith("\n\nready")).toBe(true);
  });

  it("caps a very long quoted message", () => {
    expect(prefixWithQuotedMessage("ok", "x".repeat(5000)).length).toBeLessThan(2100);
  });
});
