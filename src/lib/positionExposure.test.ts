import { OptionType } from "@stoqey/ib";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface RecordedQuery {
  table: string;
  operations: { method: string; args: unknown[] }[];
}

const mocks = vi.hoisted(() => {
  const queries: { table: string; operations: { method: string; args: unknown[] }[] }[] = [];
  const state = {
    positions: [] as unknown[],
    legs: [] as unknown[],
    rawRows: [] as unknown[],
  };

  // Chainable, thenable stand-in for a knex query builder: every chained call is recorded and returns the same builder,
  // and awaiting it yields the canned rows for the table being queried.
  function createBuilder(table: string): object {
    const query: (typeof queries)[number] = { table, operations: [] };
    queries.push(query);
    const builder: object = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            const rows = table.startsWith("positions") ? state.positions : state.legs;
            return (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) => Promise.resolve(rows).then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            query.operations.push({ method: String(property), args });
            if (property === "modify") (args[0] as (target: object) => void)(builder);
            return builder;
          };
        },
      },
    );
    return builder;
  }

  const rawMock = vi.fn((sql: string): unknown => ({ rows: state.rawRows, sql }));
  const db = Object.assign((table: string) => createBuilder(table), { raw: rawMock });
  return { queries, state, db, rawMock, fetchPricesPoolFirst: vi.fn(), streamPooledPrices: vi.fn() };
});

vi.mock("../db/connection.js", () => ({ db: mocks.db }));
vi.mock("../ibkr/pricePool.js", () => ({ fetchPricesPoolFirst: mocks.fetchPricesPoolFirst, streamPooledPrices: mocks.streamPooledPrices }));

const { computeCashLockedInCsps, computeExposureRows, computePositionExposures, computeTickerExposure, legsToPriceContracts, streamPositionExposures } = await import("./positionExposure.js");

type OpenPositionRow = Parameters<typeof computeExposureRows>[0][number];
type OpenLegRow = Parameters<typeof computeExposureRows>[1][number];

function position(overrides: Partial<OpenPositionRow> = {}): OpenPositionRow {
  return { positionId: "p1", strategyKey: "covered_call", symbol: "AAA", sector: "Technology", ...overrides };
}

function stockLeg(overrides: Partial<OpenLegRow> = {}): OpenLegRow {
  return { positionId: "p1", strategyKey: "covered_call", legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: "50", optionType: null, strikePrice: null, expiryDate: null, symbol: "AAA", ...overrides };
}

function optionLeg(overrides: Partial<OpenLegRow> = {}): OpenLegRow {
  return { positionId: "p1", strategyKey: "covered_call", legType: "option", side: "short", quantity: 1, multiplier: 100, entryPrice: "2", optionType: "call", strikePrice: "55", expiryDate: "20261120", symbol: "AAA", ...overrides };
}

function queriesOn(table: string): RecordedQuery[] {
  return mocks.queries.filter((query) => query.table === table);
}

function operationArgs(query: RecordedQuery, method: string): unknown[][] {
  return query.operations.filter((operation) => operation.method === method).map((operation) => operation.args);
}

beforeEach(() => {
  mocks.queries.length = 0;
  mocks.state.positions = [];
  mocks.state.legs = [];
  mocks.state.rawRows = [];
  mocks.rawMock.mockClear();
  mocks.fetchPricesPoolFirst.mockReset();
  mocks.fetchPricesPoolFirst.mockResolvedValue({});
  mocks.streamPooledPrices.mockReset();
});

describe("computeCashLockedInCsps", () => {
  it("returns the reserved cash the query sums, as a number", async () => {
    mocks.state.rawRows = [{ reserved: "12000.50" }];
    expect(await computeCashLockedInCsps()).toBe(12000.5);
  });

  it("is 0 when there are no rows or the sum comes back null", async () => {
    mocks.state.rawRows = [];
    expect(await computeCashLockedInCsps()).toBe(0);
    mocks.state.rawRows = [{ reserved: null }];
    expect(await computeCashLockedInCsps()).toBe(0);
  });

  it("sums strike x multiplier x quantity of the newest option leg of each open cash-secured put", async () => {
    await computeCashLockedInCsps();
    const sql = String(mocks.rawMock.mock.calls[0]![0]);
    expect(sql).toContain("pl.strike_price * pl.multiplier * pl.quantity");
    expect(sql).toContain("p.status = 'open' AND p.strategy_key = 'cash_secured_put'");
    expect(sql).toContain("ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC");
  });
});

describe("legsToPriceContracts", () => {
  it("keys each contract by its index in the leg list", () => {
    const contracts = legsToPriceContracts([stockLeg(), optionLeg(), stockLeg({ symbol: "BBB" })]);
    expect(contracts.map((contract) => contract.key)).toEqual(["0", "1", "2"]);
    expect(contracts.map((contract) => contract.symbol)).toEqual(["AAA", "AAA", "BBB"]);
  });

  it("describes a stock leg with no expiry, strike or right", () => {
    expect(legsToPriceContracts([stockLeg()])).toEqual([{ key: "0", legType: "stock", symbol: "AAA", expiry: undefined, strike: undefined, right: undefined }]);
  });

  it("describes a call leg with its expiry, numeric strike and Call right", () => {
    expect(legsToPriceContracts([optionLeg({ strikePrice: "55.50", expiryDate: "20261120", optionType: "call" })])).toEqual([
      { key: "0", legType: "option", symbol: "AAA", expiry: "20261120", strike: 55.5, right: OptionType.Call },
    ]);
  });

  it("describes a put leg with the Put right", () => {
    expect(legsToPriceContracts([optionLeg({ optionType: "put", strikePrice: "40.00" })])[0]).toMatchObject({ strike: 40, right: OptionType.Put });
  });

  it("leaves the right undefined for an option leg with no option type, and the strike undefined for a missing or empty strike", () => {
    const contracts = legsToPriceContracts([optionLeg({ optionType: null }), optionLeg({ strikePrice: null }), optionLeg({ strikePrice: "" })]);
    expect(contracts[0]!.right).toBeUndefined();
    expect(contracts[1]!.strike).toBeUndefined();
    expect(contracts[2]!.strike).toBeUndefined();
  });

  it("returns nothing for no legs", () => {
    expect(legsToPriceContracts([])).toEqual([]);
  });
});

describe("computeExposureRows", () => {
  it("values a long stock leg at price x quantity (100 shares x $52.50 = $5,250)", () => {
    const rows = computeExposureRows([position()], [stockLeg()], { "0": 52.5 });
    expect(rows).toEqual([{ positionId: "p1", strategyKey: "covered_call", symbol: "AAA", sector: "Technology", exposure: 5250 }]);
  });

  it("falls back to the entry price when the leg has no price (100 x $50 = $5,000)", () => {
    expect(computeExposureRows([position()], [stockLeg()], { "0": null })[0]!.exposure).toBe(5000);
    expect(computeExposureRows([position()], [stockLeg()], {})[0]!.exposure).toBe(5000);
  });

  it("uses a live price of 0 as a price rather than falling back to the entry price", () => {
    expect(computeExposureRows([position()], [stockLeg()], { "0": 0 })[0]!.exposure).toBe(0);
  });

  it("counts a short option as a liability (1 contract x 100 x $1.50 x -1 = -$150)", () => {
    expect(computeExposureRows([position()], [optionLeg()], { "0": 1.5 })[0]!.exposure).toBe(-150);
  });

  it("nets a covered call: 100 shares x $52 = $5,200 less a short call of 1 x 100 x $1.50 = $150 gives $5,050", () => {
    expect(computeExposureRows([position()], [stockLeg(), optionLeg()], { "0": 52, "1": 1.5 })[0]!.exposure).toBe(5050);
  });

  it("values a long option as an asset (2 contracts x 100 x $3.25 = $650)", () => {
    expect(computeExposureRows([position()], [optionLeg({ side: "long", quantity: 2 })], { "0": 3.25 })[0]!.exposure).toBe(650);
  });

  it("adds the locked collateral to a cash-secured put: 2 contracts x 100 x $50 strike = $10,000, less the put's 2 x 100 x $1.20 = $240, gives $9,760", () => {
    const csp = optionLeg({ strategyKey: "cash_secured_put", optionType: "put", strikePrice: "50.00", quantity: 2 });
    expect(computeExposureRows([position({ strategyKey: "cash_secured_put" })], [csp], { "0": 1.2 })[0]!.exposure).toBe(9760);
  });

  it("values a cash-secured put with no live price at its entry price ($2.00 x 100 x 1 = $200 liability, plus $4,000 collateral for a $40 strike = $3,800)", () => {
    const csp = optionLeg({ strategyKey: "cash_secured_put", optionType: "put", strikePrice: "40", entryPrice: "2.00" });
    expect(computeExposureRows([position({ strategyKey: "cash_secured_put" })], [csp], {})[0]!.exposure).toBe(3800);
  });

  it("adds no collateral to a cash-secured put leg that has no strike (1 x 100 x $2.40 x -1 = -$240)", () => {
    const csp = optionLeg({ strategyKey: "cash_secured_put", optionType: "put", strikePrice: null });
    expect(computeExposureRows([position({ strategyKey: "cash_secured_put" })], [csp], { "0": 2.4 })[0]!.exposure).toBe(-240);
  });

  it("adds no collateral to a short call of another strategy even though it has a strike", () => {
    expect(computeExposureRows([position()], [optionLeg({ strikePrice: "55" })], { "0": 1.5 })[0]!.exposure).toBe(-150);
  });

  it("adds no collateral to a stock leg of a cash-secured-put position", () => {
    const assignedShares = stockLeg({ strategyKey: "cash_secured_put", strikePrice: "50" });
    expect(computeExposureRows([position({ strategyKey: "cash_secured_put" })], [assignedShares], { "0": 48 })[0]!.exposure).toBe(4800);
  });

  it("applies the multiplier (1 contract x multiplier 10 x $4 x -1 = -$40)", () => {
    expect(computeExposureRows([position()], [optionLeg({ multiplier: 10 })], { "0": 4 })[0]!.exposure).toBe(-40);
  });

  it("reads prices by each leg's index across all positions, and keeps the positions separate", () => {
    const positions = [position({ positionId: "p1", symbol: "AAA" }), position({ positionId: "p2", symbol: "BBB", sector: "Energy" })];
    const legs = [stockLeg({ positionId: "p1" }), stockLeg({ positionId: "p2", symbol: "BBB", quantity: 10 }), optionLeg({ positionId: "p1", symbol: "AAA" })];
    const rows = computeExposureRows(positions, legs, { "0": 52, "1": 20, "2": 1 });
    expect(rows.map((row) => [row.positionId, row.symbol, row.sector, row.exposure])).toEqual([
      ["p1", "AAA", "Technology", 5100],
      ["p2", "BBB", "Energy", 200],
    ]);
  });

  it("gives a position with no open leg an exposure of 0, and ignores a leg of an unknown position", () => {
    const rows = computeExposureRows([position()], [stockLeg({ positionId: "other" })], { "0": 52 });
    expect(rows[0]!.exposure).toBe(0);
  });

  it("returns nothing for no positions", () => {
    expect(computeExposureRows([], [], {})).toEqual([]);
  });
});

describe("computeTickerExposure", () => {
  it("is 0 without pricing anything when the ticker has no open position", async () => {
    mocks.state.positions = [];
    expect(await computeTickerExposure("AAA")).toBe(0);
    expect(mocks.fetchPricesPoolFirst).not.toHaveBeenCalled();
    expect(queriesOn("position_legs as pl")).toEqual([]);
  });

  it("filters both the positions and the legs queries by the symbol", async () => {
    mocks.state.positions = [position()];
    mocks.state.legs = [stockLeg()];
    await computeTickerExposure("AAA");
    for (const table of ["positions as p", "position_legs as pl"]) {
      const [query] = queriesOn(table);
      expect(operationArgs(query!, "where")).toContainEqual(["t.symbol", "AAA"]);
      expect(operationArgs(query!, "where")).toContainEqual(["p.status", "open"]);
    }
    expect(operationArgs(queriesOn("position_legs as pl")[0]!, "whereNull")).toEqual([["pl.exit_at"]]);
  });

  it("sums the ticker's positions at live prices: covered call (100 x $52 - 1 x 100 x $1.50 = $5,050) plus a cash-secured put (-1 x 100 x $0.80 + 1 x 100 x $40 = $3,920) is $8,970", async () => {
    mocks.state.positions = [position({ positionId: "p1" }), position({ positionId: "p2", strategyKey: "cash_secured_put" })];
    mocks.state.legs = [
      stockLeg({ positionId: "p1" }),
      optionLeg({ positionId: "p1" }),
      optionLeg({ positionId: "p2", strategyKey: "cash_secured_put", optionType: "put", strikePrice: "40" }),
    ];
    mocks.fetchPricesPoolFirst.mockResolvedValue({ "0": 52, "1": 1.5, "2": 0.8 });
    expect(await computeTickerExposure("AAA")).toBe(8970);
  });

  it("asks the pool for every leg's contract with a 1.5 s snapshot timeout", async () => {
    mocks.state.positions = [position()];
    mocks.state.legs = [stockLeg(), optionLeg()];
    await computeTickerExposure("AAA");
    expect(mocks.fetchPricesPoolFirst).toHaveBeenCalledWith(legsToPriceContracts([stockLeg(), optionLeg()]), { snapshotTimeoutMs: 1_500 });
  });

  it("values unpriced legs at their entry price when the price fetch fails (100 x $50 - 1 x 100 x $2 = $4,800)", async () => {
    mocks.state.positions = [position()];
    mocks.state.legs = [stockLeg(), optionLeg()];
    mocks.fetchPricesPoolFirst.mockRejectedValue(new Error("snapshot refused"));
    expect(await computeTickerExposure("AAA")).toBe(4800);
  });

  it("mixes live and entry prices when only some legs came back (stock live $52 = $5,200, short call at entry $2 = -$200)", async () => {
    mocks.state.positions = [position()];
    mocks.state.legs = [stockLeg(), optionLeg()];
    mocks.fetchPricesPoolFirst.mockResolvedValue({ "0": 52, "1": null });
    expect(await computeTickerExposure("AAA")).toBe(5000);
  });

  it("is 0 for a position that has no open legs", async () => {
    mocks.state.positions = [position()];
    mocks.state.legs = [];
    expect(await computeTickerExposure("AAA")).toBe(0);
  });
});

describe("computePositionExposures", () => {
  it("returns no rows without pricing anything when no position is open", async () => {
    expect(await computePositionExposures()).toEqual([]);
    expect(mocks.fetchPricesPoolFirst).not.toHaveBeenCalled();
    expect(queriesOn("position_legs as pl")).toEqual([]);
  });

  it("does not filter by symbol, and gives the pool a 1 s settle grace", async () => {
    mocks.state.positions = [position()];
    mocks.state.legs = [stockLeg()];
    await computePositionExposures();
    expect(operationArgs(queriesOn("positions as p")[0]!, "where")).toEqual([["p.status", "open"]]);
    expect(mocks.fetchPricesPoolFirst).toHaveBeenCalledWith(legsToPriceContracts([stockLeg()]), { settleGraceMs: 1_000 });
  });

  it("returns one row per open position with its live exposure", async () => {
    mocks.state.positions = [position({ positionId: "p1", symbol: "AAA" }), position({ positionId: "p2", symbol: "BBB", sector: "Unknown" })];
    mocks.state.legs = [stockLeg({ positionId: "p1" }), stockLeg({ positionId: "p2", symbol: "BBB", quantity: 30 })];
    mocks.fetchPricesPoolFirst.mockResolvedValue({ "0": 52, "1": 10 });
    expect(await computePositionExposures()).toEqual([
      { positionId: "p1", strategyKey: "covered_call", symbol: "AAA", sector: "Technology", exposure: 5200 },
      { positionId: "p2", strategyKey: "covered_call", symbol: "BBB", sector: "Unknown", exposure: 300 },
    ]);
  });

  it("values every leg at its entry price when the price fetch throws", async () => {
    mocks.state.positions = [position()];
    mocks.state.legs = [stockLeg()];
    mocks.fetchPricesPoolFirst.mockRejectedValue(new Error("pool unavailable"));
    expect((await computePositionExposures())[0]!.exposure).toBe(5000);
  });

  it("shares one in-flight computation between simultaneous callers, then recomputes for the next caller", async () => {
    mocks.state.positions = [position()];
    mocks.state.legs = [stockLeg()];
    const [first, second] = await Promise.all([computePositionExposures(), computePositionExposures()]);
    expect(first).toBe(second);
    expect(queriesOn("positions as p")).toHaveLength(1);
    expect(mocks.fetchPricesPoolFirst).toHaveBeenCalledTimes(1);

    await computePositionExposures();
    expect(queriesOn("positions as p")).toHaveLength(2);
  });
});

describe("streamPositionExposures", () => {
  type PriceHandler = (pricesByKey: Record<string, number | null>, meta: { frozenPhaseComplete: boolean }) => void;

  async function runStreamWithHandlerCapture(): Promise<{ onUpdate: ReturnType<typeof vi.fn>; handler: PriceHandler }> {
    let handler: PriceHandler = () => {};
    mocks.streamPooledPrices.mockImplementation(async (_contracts: unknown, onPrices: PriceHandler) => {
      handler = onPrices;
    });
    const onUpdate = vi.fn();
    await streamPositionExposures(onUpdate, new AbortController().signal);
    return { onUpdate, handler };
  }

  beforeEach(() => {
    mocks.state.positions = [position()];
    mocks.state.legs = [stockLeg(), optionLeg()];
  });

  it("streams the contracts of every open leg", async () => {
    await runStreamWithHandlerCapture();
    expect(mocks.streamPooledPrices.mock.calls[0]![0]).toEqual(legsToPriceContracts([stockLeg(), optionLeg()]));
  });

  it("holds the first reading until every leg has a price", async () => {
    const { onUpdate, handler } = await runStreamWithHandlerCapture();
    handler({ "0": 52, "1": null }, { frozenPhaseComplete: false });
    handler({ "0": 52 }, { frozenPhaseComplete: false });
    expect(onUpdate).not.toHaveBeenCalled();
    handler({ "0": 52, "1": 1.5 }, { frozenPhaseComplete: false });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0][0].exposure).toBe(5050);
  });

  it("emits a partial first reading, with entry prices for the missing legs, once the frozen phase is complete", async () => {
    const { onUpdate, handler } = await runStreamWithHandlerCapture();
    handler({ "0": 52, "1": null }, { frozenPhaseComplete: true });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0][0].exposure).toBe(5000);
  });

  it("after the first reading, emits every update even when a leg has lost its price", async () => {
    const { onUpdate, handler } = await runStreamWithHandlerCapture();
    handler({ "0": 52, "1": 1.5 }, { frozenPhaseComplete: false });
    handler({ "0": 53, "1": null }, { frozenPhaseComplete: false });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1]![0][0].exposure).toBe(5100);
  });

  it("with no open position, reports an empty reading and returns without streaming once aborted", async () => {
    mocks.state.positions = [];
    const controller = new AbortController();
    const onUpdate = vi.fn();
    const streaming = streamPositionExposures(onUpdate, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await streaming;
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith([]);
    expect(mocks.streamPooledPrices).not.toHaveBeenCalled();
  });
});
