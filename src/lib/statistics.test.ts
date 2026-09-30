import { describe, expect, it } from "vitest";
import { median } from "./statistics.js";

describe("median", () => {
  it("takes the middle value of an odd count and the mean of the two middle values of an even count, whatever the input order", () => {
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("does not reorder or change its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});
