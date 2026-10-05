import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenosukeApiClient } from "./apiClient.js";
import type { PositionForCard } from "./confirmationText.js";
import { createConfirmation, takeConfirmation } from "./confirmations.js";
import { financialWriteTools } from "./tools/financialWriteTools.js";
import type { GenosukeTool } from "./tools/types.js";

type Handler = (path: string, body?: unknown) => unknown;

/** A scripted API client that records every call as "METHOD path" plus its body. */
function fakeApi(handlers: { get?: Handler; post?: Handler; put?: Handler }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const record = (method: string, handler: Handler | undefined) => async (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return handler?.(path, body);
  };
  const api = { get: record("GET", handlers.get), post: record("POST", handlers.post), put: record("PUT", handlers.put) } as unknown as GenosukeApiClient;
  return { api, calls, paths: () => calls.map((call) => `${call.method} ${call.path}`) };
}

function toolNamed(name: string): GenosukeTool {
  const tool = financialWriteTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

const noCommissionWarning = { warn: false, netPremiumDollars: 270, commissionSharePctOfPremium: 0.5, warnThresholdPct: 5 };

const putInput = { symbol: "AAOI", strategyKey: "cash_secured_put", option: { quantity: 2, limitPrice: 1.35, strikePrice: 50, expiryDate: "20261016" } };
const callInput = {
  symbol: "AAOI",
  strategyKey: "covered_call",
  stock: { quantity: 200, limitPrice: 48.2 },
  option: { quantity: 2, limitPrice: 1.1, strikePrice: 55, expiryDate: "20261016" },
};

/** The order the server builds for an open request: what it stores, which can differ from what the model asked for. */
function builtOpenOrder(body: unknown, extraStockShares?: number) {
  const input = body as { symbol: string; strategyKey: string; stock?: { quantity: number; limitPrice: number }; option: { quantity: number; limitPrice: number; strikePrice: number; expiryDate: string } };
  const legs: Record<string, unknown>[] = [];
  const stockShares = input.stock?.quantity ?? extraStockShares;
  if (input.strategyKey === "covered_call" && stockShares) legs.push({ role: "stock", action: "BUY", symbol: input.symbol, quantity: stockShares, unitPrice: input.stock?.limitPrice ?? 48.2 });
  legs.push({
    role: "option",
    action: "SELL",
    symbol: input.symbol,
    quantity: input.option.quantity,
    unitPrice: input.option.limitPrice,
    strike: input.option.strikePrice,
    expiry: input.option.expiryDate,
    right: input.strategyKey === "covered_call" ? "C" : "P",
  });
  return { id: "order-1", requestType: input.strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put", payload: { symbol: input.symbol, strategyKey: input.strategyKey, legs } };
}

/** Handlers for a built order that passes the gate with the given warnings. */
function openHandlers(options: { blocks?: string[]; warnings?: string[]; confirmFails?: boolean; serverFilledShares?: number } = {}) {
  return {
    post: (path: string, body?: unknown) => {
      if (path === "/positions/orders") return builtOpenOrder(body, options.serverFilledShares);
      if (path === "/order-checks/commission-preview") return noCommissionWarning;
      if (path.endsWith("/confirm")) {
        if (options.confirmFails) throw new Error("Trading is blocked");
        return { id: "order-1", status: "confirmed" };
      }
      return {};
    },
    get: () => ({ blocks: options.blocks ?? [], warnings: options.warnings ?? [] }),
  };
}

describe("the tool set", () => {
  it("lists create_position, close_position, update_risk_limits and set_trading_halt as financial-write tools", () => {
    expect(financialWriteTools.map((tool) => `${tool.name}:${tool.tier}`)).toEqual([
      "create_position:financial-write",
      "close_position:financial-write",
      "update_risk_limits:financial-write",
      "set_trading_halt:financial-write",
    ]);
  });

  it("the two order tools prepare a confirmation and track the order; update_risk_limits does neither", () => {
    for (const name of ["create_position", "close_position"]) {
      const tool = toolNamed(name);
      expect(typeof tool.prepareConfirmation).toBe("function");
      expect(typeof tool.discardPrepared).toBe("function");
      expect(tool.tracksOrderStatus).toBe(true);
    }
    const risk = toolNamed("update_risk_limits");
    expect(risk.prepareConfirmation).toBeUndefined();
    expect(risk.discardPrepared).toBeUndefined();
    expect(risk.tracksOrderStatus).toBeUndefined();
  });

  it("update_risk_limits takes the eleven settings of the single set, none required, and nothing per strategy", () => {
    const parameters = toolNamed("update_risk_limits").parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(parameters.properties).sort()).toEqual(
      ["commissionWarnSharePctOfPremium", "deltaTargetMax", "deltaTargetMin", "maxConcentrationPerTickerPct", "maxPositionPctOfPortfolio", "minAnnualizedYieldPct", "minCashReservePct", "priceCheckMaxDeviationPct", "priceCheckMinToleranceDollars", "recoveryDteMax", "recoveryDteMin"].sort(),
    );
    expect(parameters.required).toBeUndefined();
    expect(parameters.properties).not.toHaveProperty("strategyKey");
  });
});

describe("create_position", () => {
  const tool = toolNamed("create_position");

  it("prepareConfirmation builds the order, reads its gates and returns the card of the BUILT order with its id", async () => {
    const { api, paths, calls } = fakeApi(openHandlers());
    const result = await tool.prepareConfirmation!(putInput, api);
    expect(result).toEqual({
      description: "Place order for AAOI (cash-secured put)\n• SELL 2 put $50 exp 2026-10-16, limit 1.35\nOne limit order, sent to IBKR immediately when you tap Yes.",
      prepared: { orderId: "order-1" },
    });
    expect(paths()).toEqual(["POST /positions/orders", "GET /positions/orders/order-1/gates", "POST /order-checks/commission-preview"]);
    expect(calls[0]!.body).toEqual(putInput);
  });

  it("the card of a covered call shows the stock leg too", async () => {
    const { api } = fakeApi(openHandlers());
    const result = await tool.prepareConfirmation!(callInput, api);
    expect((result as { description: string }).description).toBe(
      "Place order for AAOI (covered call)\n• BUY 200 shares, limit 48.20\n• SELL 2 call $55 exp 2026-10-16, limit 1.10\nOne combo order, sent to IBKR immediately when you tap Yes.",
    );
  });

  it("the card shows a stock leg the SERVER added although the model sent none (what is confirmed is what is shown)", async () => {
    const { api } = fakeApi(openHandlers({ serverFilledShares: 200 }));
    const { stock: _omitted, ...callInputWithoutStock } = callInput;
    const result = await tool.prepareConfirmation!(callInputWithoutStock, api);
    const description = (result as { description: string }).description;
    expect(description).toContain("• BUY 200 shares, limit 48.20");
    expect(description).toContain("One combo order");
  });

  it("adds the gate's warnings under the base card", async () => {
    const { api } = fakeApi(openHandlers({ warnings: ["1 economic event before expiry: 2026-10-07 FOMC."] }));
    const result = (await tool.prepareConfirmation!(putInput, api)) as { description: string };
    expect(result.description.split("\n\n")[1]).toBe("⚠ Warnings:\n• 1 economic event before expiry: 2026-10-07 FOMC.");
    expect(result.description.startsWith("Place order for AAOI (cash-secured put)")).toBe(true);
  });

  it("a gate block gives a problem (no card) and cancels the order that was built", async () => {
    const { api, paths } = fakeApi(openHandlers({ blocks: ["This order is 12.0% of portfolio value, above the 10% max position size.", "Delta has drifted to 0.50, above the 0.2–0.3 delta band."] }));
    const result = await tool.prepareConfirmation!(putInput, api);
    expect(result).toEqual({ problem: "Blocked, nothing was placed: This order is 12.0% of portfolio value, above the 10% max position size. Delta has drifted to 0.50, above the 0.2–0.3 delta band." });
    expect(paths()).toContain("POST /positions/orders/order-1/cancel");
    expect(paths()).not.toContain("POST /order-checks/commission-preview");
  });

  it("a build failure is a problem and nothing is cancelled", async () => {
    const { api, paths } = fakeApi({
      post: () => {
        throw new Error("Unknown symbol — add it via the Shortlist first.");
      },
    });
    expect(await tool.prepareConfirmation!(putInput, api)).toEqual({ problem: "The order could not be built, nothing was placed: Unknown symbol — add it via the Shortlist first." });
    expect(paths()).toEqual(["POST /positions/orders"]);
  });

  it("execute with a prepared order confirms THAT order and builds nothing", async () => {
    const { api, paths } = fakeApi(openHandlers());
    const result = await tool.execute(putInput, api, { orderId: "prepared-7" });
    expect(result).toEqual({ id: "order-1", status: "confirmed" });
    expect(paths()).toEqual(["POST /positions/orders/prepared-7/confirm"]);
  });

  it("execute with a prepared order cancels it when the confirm is refused, and rethrows", async () => {
    const { api, paths } = fakeApi(openHandlers({ confirmFails: true }));
    await expect(tool.execute(putInput, api, { orderId: "prepared-7" })).rejects.toThrow("Trading is blocked");
    expect(paths()).toEqual(["POST /positions/orders/prepared-7/confirm", "POST /positions/orders/prepared-7/cancel"]);
  });

  it("execute without a prepared order falls back to build then confirm", async () => {
    const { api, paths, calls } = fakeApi(openHandlers());
    const result = await tool.execute(putInput, api);
    expect(result).toEqual({ id: "order-1", status: "confirmed" });
    expect(paths()).toEqual(["POST /positions/orders", "POST /positions/orders/order-1/confirm"]);
    expect(calls[0]!.body).toEqual(putInput);
  });

  it("the fallback cancels the order it built when the confirm fails", async () => {
    const { api, paths } = fakeApi(openHandlers({ confirmFails: true }));
    await expect(tool.execute(putInput, api)).rejects.toThrow("Trading is blocked");
    expect(paths()).toEqual(["POST /positions/orders", "POST /positions/orders/order-1/confirm", "POST /positions/orders/order-1/cancel"]);
  });

  it("discardPrepared cancels the prepared order, and does nothing without one", async () => {
    const { api, paths } = fakeApi({ post: () => ({}) });
    await tool.discardPrepared!({ orderId: "prepared-7" }, api);
    await tool.discardPrepared!(undefined, api);
    expect(paths()).toEqual(["POST /positions/orders/prepared-7/cancel"]);
  });
});

describe("close_position", () => {
  const tool = toolNamed("close_position");
  const position: PositionForCard = {
    symbol: "AAOI",
    strategyKey: "cash_secured_put",
    status: "open",
    legs: [{ id: "leg-1", legType: "option", side: "short", quantity: 2, optionType: "put", strikePrice: 50, expiryDate: "2026-10-16", exitAt: null }],
  };
  const closeInput = { positionId: "pos-1", legs: [{ legId: "leg-1", limitPrice: 0.5 }] };

  function closeHandlers(options: { blocks?: string[]; closeBuildFails?: string } = {}) {
    return {
      get: (path: string) => (path === "/positions/pos-1" ? position : { blocks: options.blocks ?? [], warnings: [] }),
      post: (path: string) => {
        if (path === "/positions/pos-1/close") {
          if (options.closeBuildFails) throw new Error(options.closeBuildFails);
          return {
            id: "close-order-1",
            requestType: "close_position",
            payload: { symbol: "AAOI", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "BUY", symbol: "AAOI", quantity: 2, unitPrice: 0.5, strike: 50, expiry: "20261016", right: "P", positionLegId: "leg-1" }] },
          };
        }
        if (path === "/order-checks/commission-preview") return noCommissionWarning;
        if (path.endsWith("/confirm")) return { id: "close-order-1", status: "confirmed" };
        return {};
      },
    };
  }

  it("prepareConfirmation builds the close with the model's legs and returns the close card with the built order's id", async () => {
    const { api, paths, calls } = fakeApi(closeHandlers());
    const result = await tool.prepareConfirmation!(closeInput, api);
    expect(result).toEqual({
      description: "Close AAOI (cash-secured put)\n• BUY BACK 2 put $50 exp 2026-10-16, limit 0.50\nOne limit order, sent to IBKR immediately when you tap Yes.",
      prepared: { orderId: "close-order-1" },
    });
    expect(paths()).toEqual(["GET /positions/pos-1", "POST /positions/pos-1/close", "GET /positions/orders/close-order-1/gates", "POST /order-checks/commission-preview"]);
    expect(calls[1]!.body).toEqual({ legs: closeInput.legs });
  });

  it("returns a problem and builds nothing when the legs are not exactly the open legs", async () => {
    const { api, paths } = fakeApi(closeHandlers());
    const result = await tool.prepareConfirmation!({ positionId: "pos-1", legs: [{ legId: "ghost-leg", limitPrice: 1 }] }, api);
    expect(result.problem).toContain("these legs are not open");
    expect(result.problem).toContain("ghost-leg");
    expect(paths()).toEqual(["GET /positions/pos-1"]);
  });

  it("a gate block (the close gate, trading gate) is a problem and the built close order is cancelled", async () => {
    const { api, paths } = fakeApi(closeHandlers({ blocks: ["Closing is blocked: the market is closed."] }));
    const result = await tool.prepareConfirmation!(closeInput, api);
    expect(result).toEqual({ problem: "Blocked, nothing was placed: Closing is blocked: the market is closed." });
    expect(paths()).toContain("POST /positions/orders/close-order-1/cancel");
  });

  it("the build route refusing the close (for example the close gate at build time) is a problem too", async () => {
    const { api, paths } = fakeApi(closeHandlers({ closeBuildFails: "Closing is blocked: the market is closed." }));
    expect(await tool.prepareConfirmation!(closeInput, api)).toEqual({ problem: "The order could not be built, nothing was placed: Closing is blocked: the market is closed." });
    expect(paths()).not.toContain("GET /positions/orders/close-order-1/gates");
  });

  it("execute with a prepared order confirms that order and does not rebuild the close", async () => {
    const { api, paths } = fakeApi(closeHandlers());
    await tool.execute(closeInput, api, { orderId: "close-order-9" });
    expect(paths()).toEqual(["POST /positions/orders/close-order-9/confirm"]);
  });

  it("execute without a prepared order builds the close then confirms it", async () => {
    const { api, paths, calls } = fakeApi(closeHandlers());
    await tool.execute(closeInput, api);
    expect(paths()).toEqual(["POST /positions/pos-1/close", "POST /positions/orders/close-order-1/confirm"]);
    expect(calls[0]!.body).toEqual({ legs: closeInput.legs });
  });

  it("discardPrepared cancels the prepared close order", async () => {
    const { api, paths } = fakeApi({ post: () => ({}) });
    await tool.discardPrepared!({ orderId: "close-order-9" }, api);
    expect(paths()).toEqual(["POST /positions/orders/close-order-9/cancel"]);
  });
});

describe("update_risk_limits", () => {
  const tool = toolNamed("update_risk_limits");
  const current = {
    maxPositionPctOfPortfolio: 10,
    maxConcentrationPerTickerPct: 20,
    minCashReservePct: 5,
    deltaTargetMin: 0.2,
    deltaTargetMax: 0.3,
    recoveryDteMin: 30,
    recoveryDteMax: 45,
    minAnnualizedYieldPct: 50,
    commissionWarnSharePctOfPremium: 5,
    updatedAt: "2026-10-05T02:31:28.872Z",
    updatedByDisplayName: "Marce",
  };

  it("validateBeforeConfirmation rejects an empty change and accepts any non-empty one", async () => {
    const { api } = fakeApi({});
    expect(await tool.validateBeforeConfirmation!({}, api)).toBe("Send at least one setting to change.");
    expect(await tool.validateBeforeConfirmation!({ minCashReservePct: 8 }, api)).toBeNull();
  });

  it("describeForConfirmation reads the current settings and shows each change as old to new", async () => {
    const { api, paths } = fakeApi({ get: () => current });
    const card = await tool.describeForConfirmation!({ minCashReservePct: 8, deltaTargetMax: 0.35 }, api);
    expect(paths()).toEqual(["GET /risk-limits/settings"]);
    expect(card).toBe("Update the trading limits\n• Min cash reserve %: 5 → 8\n• Delta band max: 0.3 → 0.35");
  });

  it("describeForConfirmation shows a bare value for a setting that is not changing", async () => {
    const { api } = fakeApi({ get: () => current });
    expect(await tool.describeForConfirmation!({ minCashReservePct: 5 }, api)).toBe("Update the trading limits\n• Min cash reserve %: 5");
  });

  it("execute merges the changes over the current settings (without updatedAt and updatedByDisplayName) and PUTs the complete set", async () => {
    const { api, calls } = fakeApi({ get: () => current, put: () => ({ saved: true }) });
    const result = await tool.execute({ minCashReservePct: 8, deltaTargetMax: 0.35 }, api);
    expect(result).toEqual({ saved: true });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /risk-limits/settings", "PUT /risk-limits/settings"]);
    expect(calls[1]!.body).toEqual({
      maxPositionPctOfPortfolio: 10,
      maxConcentrationPerTickerPct: 20,
      minCashReservePct: 8,
      deltaTargetMin: 0.2,
      deltaTargetMax: 0.35,
      recoveryDteMin: 30,
      recoveryDteMax: 45,
      minAnnualizedYieldPct: 50,
      commissionWarnSharePctOfPremium: 5,
    });
    expect(calls[1]!.body).not.toHaveProperty("updatedAt");
    expect(calls[1]!.body).not.toHaveProperty("updatedByDisplayName");
  });

  it("execute lets the change win over the current value for every field it names, including setting a value back to zero", async () => {
    const { api, calls } = fakeApi({ get: () => current, put: () => ({}) });
    await tool.execute({ minCashReservePct: 0, maxPositionPctOfPortfolio: 0 }, api);
    expect(calls[1]!.body).toMatchObject({ minCashReservePct: 0, maxPositionPctOfPortfolio: 0, deltaTargetMin: 0.2 });
  });

  it("execute does not save anything when the current settings cannot be read", async () => {
    const { api, calls } = fakeApi({
      get: () => {
        throw new Error("API down");
      },
      put: () => ({}),
    });
    await expect(tool.execute({ minCashReservePct: 8 }, api)).rejects.toThrow("API down");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("execute passes the route's refusal on to the caller", async () => {
    const { api } = fakeApi({
      get: () => current,
      put: () => {
        throw new Error("deltaTargetMin cannot exceed deltaTargetMax.");
      },
    });
    await expect(tool.execute({ deltaTargetMin: 0.9 }, api)).rejects.toThrow("deltaTargetMin cannot exceed deltaTargetMax.");
  });

  // A model that invents a setting name must not get a card with no lines (Yes would re-save the unchanged settings).
  it("a change made only of unknown setting names is refused before a card is sent", async () => {
    const { api } = fakeApi({ get: () => current });
    expect(await tool.validateBeforeConfirmation!({ notASetting: 5 }, api)).not.toBeNull();
  });
});

describe("confirmations: prepared state and single use", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps what prepareConfirmation set up and hands it back, along with the card text and input", () => {
    const prepared = { orderId: "order-1" };
    const confirmation = createConfirmation("chat-1", "create_position", { symbol: "AAOI" }, "CARD", prepared);
    const taken = takeConfirmation(confirmation.id);
    expect(taken).toMatchObject({ id: confirmation.id, chatId: "chat-1", toolName: "create_position", input: { symbol: "AAOI" }, description: "CARD", prepared });
    expect(taken!.prepared).toBe(prepared);
  });

  it("has no prepared state for a tool that does not prepare", () => {
    const confirmation = createConfirmation("chat-1", "update_risk_limits", { minCashReservePct: 8 }, "CARD");
    expect(takeConfirmation(confirmation.id)!.prepared).toBeUndefined();
  });

  it("takeConfirmation is single use: the second take, of a confirmed or cancelled card, finds nothing", () => {
    const confirmation = createConfirmation("chat-1", "create_position", {}, "CARD", { orderId: "order-1" });
    expect(takeConfirmation(confirmation.id)).not.toBeNull();
    expect(takeConfirmation(confirmation.id)).toBeNull();
  });

  it("an unknown id finds nothing", () => {
    expect(takeConfirmation("no-such-confirmation")).toBeNull();
  });

  it("two cards are independent: taking one leaves the other", () => {
    const first = createConfirmation("chat-1", "create_position", {}, "ONE", { orderId: "a" });
    const second = createConfirmation("chat-1", "create_position", {}, "TWO", { orderId: "b" });
    expect(first.id).not.toBe(second.id);
    expect(takeConfirmation(first.id)!.prepared).toEqual({ orderId: "a" });
    expect(takeConfirmation(second.id)!.prepared).toEqual({ orderId: "b" });
  });

  it("a card is still valid at exactly 10 minutes and gone after, and an expired take is single use too", () => {
    const stillValid = createConfirmation("chat-1", "create_position", {}, "CARD", { orderId: "a" });
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(takeConfirmation(stillValid.id)).not.toBeNull();

    const expired = createConfirmation("chat-1", "create_position", {}, "CARD", { orderId: "b" });
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(takeConfirmation(expired.id)).toBeNull();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    expect(takeConfirmation(expired.id)).toBeNull();
  });

  it("creating a new card sweeps the ones that have expired", () => {
    const old = createConfirmation("chat-1", "create_position", {}, "OLD", { orderId: "old" });
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    createConfirmation("chat-1", "create_position", {}, "NEW");
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z")); // even if the clock were wound back, the swept card is gone
    expect(takeConfirmation(old.id)).toBeNull();
  });
});

describe("set_trading_halt", () => {
  const tool = toolNamed("set_trading_halt");

  it("is a confirmed (card) tool that neither prepares an order nor tracks one", () => {
    expect(tool.tier).toBe("financial-write");
    expect(tool.prepareConfirmation).toBeUndefined();
    expect(tool.tracksOrderStatus).toBeUndefined();
    expect((tool.parameters as { required: string[] }).required).toEqual(["enabled"]);
  });

  it("refuses to send a card for halting without a reason, for a bad enabled, or for a reason over 300 characters", async () => {
    const { api } = fakeApi({});
    expect(await tool.validateBeforeConfirmation!({ enabled: true }, api)).toContain("reason is required");
    expect(await tool.validateBeforeConfirmation!({ enabled: true, reason: "   " }, api)).toContain("reason is required");
    expect(await tool.validateBeforeConfirmation!({ enabled: "yes" }, api)).toContain("true (halt) or false (resume)");
    expect(await tool.validateBeforeConfirmation!({ enabled: true, reason: "x".repeat(301) }, api)).toContain("at most 300");
    expect(await tool.validateBeforeConfirmation!({ enabled: true, reason: "x".repeat(300) }, api)).toBeNull();
  });

  it("allows resuming with or without a reason", async () => {
    const { api } = fakeApi({});
    expect(await tool.validateBeforeConfirmation!({ enabled: false }, api)).toBeNull();
    expect(await tool.validateBeforeConfirmation!({ enabled: false, reason: "data is fine again" }, api)).toBeNull();
  });

  it("the card says plainly what halting and resuming do", async () => {
    const { api } = fakeApi({});
    expect(await tool.describeForConfirmation!({ enabled: true, reason: "IBKR data looks wrong" }, api)).toBe(
      "HALT ALL TRADING: no order from any origin reaches IBKR until it is resumed (cancels still work). Reason: IBKR data looks wrong",
    );
    expect(await tool.describeForConfirmation!({ enabled: false }, api)).toBe("RESUME TRADING: orders reach IBKR again from every origin.");
    expect(await tool.describeForConfirmation!({ enabled: false, reason: "fixed" }, api)).toBe("RESUME TRADING: orders reach IBKR again from every origin. Reason: fixed");
  });

  it("execute puts the switch with a trimmed reason (null when none) and the result is worded for the human", async () => {
    const { api, calls } = fakeApi({ put: () => ({ enabled: true, reason: "r" }) });
    const halted = await tool.execute({ enabled: true, reason: "  IBKR data looks wrong " }, api);
    expect(calls[0]).toEqual({ method: "PUT", path: "/risk-limits/trading-halt", body: { enabled: true, reason: "IBKR data looks wrong" } });
    expect(tool.describeResult!(halted)).toContain("HALTED");
    await tool.execute({ enabled: false }, api);
    expect(calls[1]!.body).toEqual({ enabled: false, reason: null });
    expect(tool.describeResult!({ enabled: false })).toContain("resumed");
  });
});
