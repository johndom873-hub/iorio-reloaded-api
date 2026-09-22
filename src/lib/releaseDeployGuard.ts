import type { MarketSessionState } from "./marketSessionStatus.js";
import type { AppEnvironment } from "./appEnvironment.js";

// Phase B: order-flow is DAY-only everywhere (TimeInForce.DAY in every buildOrder path), so an
// order still sitting in one of the in-flight statuses is only ever expected while the market is
// open -- redeploying the worker mid-session (or with something genuinely still in flight) is the
// exact risk this guard exists to catch, on top of (not instead of) the SIGTERM handler's own
// drain, since a restart landing between a fill and its reconciliation pass is a different window
// than this guard is about. Approved design (PROGRESS.md, "Deploy guards"): production ABORTS the
// whole release on either condition; staging only WARNS and proceeds, or every daytime push during
// active staging development would fail.
export const inFlightOrderStatuses = ["confirmed", "cancel_requested", "partially_filled", "submitted"] as const;

export interface ReleaseDeployGuardInputs {
  appEnvironment: AppEnvironment;
  marketSessionState: MarketSessionState;
  /** True within the post-close settlement buffer (~15 min after the 16:00 ET close) — a DAY order can still be settling then. */
  isWithinPostCloseBuffer: boolean;
  inFlightOrderCount: number;
}

export interface ReleaseDeployGuardVerdict {
  problems: string[];
  /** True only for production with at least one problem — staging never blocks, only warns. */
  shouldAbort: boolean;
}

export function evaluateReleaseDeployGuard(inputs: ReleaseDeployGuardInputs): ReleaseDeployGuardVerdict {
  const problems: string[] = [];
  if (inputs.marketSessionState === "open") problems.push("the market is currently open");
  if (inputs.isWithinPostCloseBuffer) problems.push("within the post-close settlement buffer (~15 min after the 16:00 ET close)");
  if (inputs.inFlightOrderCount > 0) {
    problems.push(`${inputs.inFlightOrderCount} order(s) in an in-flight status (${inFlightOrderStatuses.join("/")})`);
  }
  return { problems, shouldAbort: inputs.appEnvironment === "production" && problems.length > 0 };
}
