import { describe, expect, it } from "vitest";
import { parseProcessListing, selectLeftoverJobProcesses } from "./spawnBacktestJobProcess.js";

const jobId = "6f1c1d1e-0000-4000-8000-000000000001";
const listing = [
  `  4100  4100 /opt/homebrew/bin/node --import tsx /repo/scripts/run-backtest-job.ts ${jobId}`,
  "  4101  4100 /repo/.venv-backtest/bin/python /repo/scripts/backtest/download_thetadata_symbol.py --symbol AAOI",
  "  4102  4100 /bin/zsh -c something else in the group",
  "  4200  4200 /opt/homebrew/bin/node --import tsx /repo/scripts/run-backtest-job.ts 6f1c1d1e-0000-4000-8000-000000000002",
  "  4300  4300 /usr/bin/vim notes.txt",
].join("\n");

describe("leftover job processes", () => {
  it("parses ps output", () => {
    expect(parseProcessListing(listing)[1]).toEqual({ pid: 4101, processGroupId: 4100, command: "/repo/.venv-backtest/bin/python /repo/scripts/backtest/download_thetadata_symbol.py --symbol AAOI" });
  });

  it("selects only this job's process and its downloader in the group it led", () => {
    expect(selectLeftoverJobProcesses(parseProcessListing(listing), 4100, jobId).map((listed) => listed.pid)).toEqual([4100, 4101]);
  });

  it("selects nothing when the pid now belongs to an unrelated process", () => {
    expect(selectLeftoverJobProcesses(parseProcessListing(listing), 4300, jobId)).toEqual([]);
  });

  it("finds the orphaned downloader after the job process itself was killed", () => {
    const withoutLeader = parseProcessListing(listing).filter((listed) => listed.pid !== 4100);
    expect(selectLeftoverJobProcesses(withoutLeader, 4100, jobId).map((listed) => listed.pid)).toEqual([4101]);
  });
});
