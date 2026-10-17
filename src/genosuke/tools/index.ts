import { readTools } from "./readTools.js";
import { lowStakesWriteTools } from "./lowStakesWriteTools.js";
import { infraWriteTools } from "./infraWriteTools.js";
import type { GenosukeTool } from "./types.js";

export const ALL_TOOLS: GenosukeTool[] = [...readTools, ...lowStakesWriteTools, ...infraWriteTools];
export const TOOLS_BY_NAME: Map<string, GenosukeTool> = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

export type { GenosukeTool, GenosukeToolTier } from "./types.js";
