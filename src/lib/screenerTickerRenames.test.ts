import { describe, expect, it } from "vitest";
import { findTickerRenames } from "./screenerTickerRenames.js";

const stored = (symbol: string, ibkrContractId: number | null) => ({ symbol, ibkrContractId });
const match = (symbol: string, conId: number | null) => ({ symbol, conId });

describe("findTickerRenames", () => {
  it("renames a stored row when a new symbol arrives with its contract id and the old ticker did not match", () => {
    expect(findTickerRenames([match("SKYD", 804144296)], [stored("PSKY", 804144296), stored("AAPL", 265598)])).toEqual([{ oldSymbol: "PSKY", newSymbol: "SKYD", ibkrContractId: 804144296 }]);
  });

  it("is not a rename when the old ticker also matched tonight", () => {
    expect(findTickerRenames([match("SKYD", 804144296), match("PSKY", 804144296)], [stored("PSKY", 804144296)])).toEqual([]);
  });

  it("is not a rename when the new symbol is already stored (both rows exist)", () => {
    expect(findTickerRenames([match("SKYD", 804144296)], [stored("PSKY", 804144296), stored("SKYD", 804144296)])).toEqual([]);
  });

  it("needs a contract id from the scanner and on the stored row", () => {
    expect(findTickerRenames([match("SKYD", null)], [stored("PSKY", 804144296)])).toEqual([]);
    expect(findTickerRenames([match("SKYD", 804144296)], [stored("PSKY", null)])).toEqual([]);
  });

  it("skips a contract id that more than one stored row carries", () => {
    expect(findTickerRenames([match("NEW", 1)], [stored("OLD1", 1), stored("OLD2", 1)])).toEqual([]);
  });

  it("renames a stored row only once when two new symbols carry its contract id", () => {
    expect(findTickerRenames([match("NEW1", 1), match("NEW2", 1)], [stored("OLD", 1)])).toEqual([{ oldSymbol: "OLD", newSymbol: "NEW1", ibkrContractId: 1 }]);
  });

  it("finds nothing for a genuinely new contract id", () => {
    expect(findTickerRenames([match("NEW", 2)], [stored("OLD", 1)])).toEqual([]);
  });
});
