import type { PlutoExecutionStrategy } from "./settingsStore.js";

// Pluto's execution strategies (Marcelo 2026-10-15): one active at a time, chosen by pluto_settings.execution_strategy.

export const executionStrategyLabels: Record<PlutoExecutionStrategy, string> = {
  edge_margin: "Edge Margin",
  cc_put_ladder: "CC + Put Ladder",
};

/** The strategies whose decision code exists. Pluto never acts under any other, so a selected strategy can't trade half-built. */
const executionStrategiesBuilt: ReadonlySet<PlutoExecutionStrategy> = new Set(["edge_margin"]);

/** Why Pluto cannot act under this strategy, or null when it can. */
export function describeExecutionStrategyBlock(strategy: PlutoExecutionStrategy): string | null {
  if (executionStrategiesBuilt.has(strategy)) return null;
  return `The ${executionStrategyLabels[strategy]} strategy is selected but not built yet: switch back to ${executionStrategyLabels.edge_margin} to let Pluto act.`;
}
