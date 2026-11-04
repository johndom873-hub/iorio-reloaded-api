import { describe, expect, it } from "vitest";
import { ProjectionStoppedError, runProjectionInParallel } from "./portfolioProjectionPool.js";
import type { ProjectionInput } from "./portfolioDayProjection.js";

// The pool's stop: a stopped signal ends the run with ProjectionStoppedError before any worker starts.
describe("the projection pool", () => {
  it("refuses to start once its signal is stopped", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const path = { days: Int32Array.from([0]), leftoverDraws: Float64Array.from([0]) };
    await expect(runProjectionInParallel({} as ProjectionInput, [path, path], undefined, 2, stopped.signal)).rejects.toBeInstanceOf(ProjectionStoppedError);
  });
});
