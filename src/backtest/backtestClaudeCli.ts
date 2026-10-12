import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Where the backtest's LLM mode finds the Claude Code CLI it asks through Marcelo's subscription (src/backtest/llm/):
// BACKTEST_CLAUDE_CLI_PATH in .env, explicitly, with no default; and the empty folder the CLI runs in, outside every
// project, so it picks up no project instructions. Run inside the repo, the CLI reads the project's CLAUDE.md and memory
// into every call (measured: 10,617 tokens of context against 5,493 from a folder outside it, on the same decision).

/** The CLI's path from BACKTEST_CLAUDE_CLI_PATH; null when it is not set. */
export function readBacktestClaudeCliPath(): string | null {
  const value = process.env.BACKTEST_CLAUDE_CLI_PATH?.trim();
  return value ? value : null;
}

export const backtestClaudeCliPathMissingMessage = "The AI model as decision maker needs BACKTEST_CLAUDE_CLI_PATH in the API's .env (the Claude Code CLI to call): set it and restart the API.";

/** The CLI's working directory: an empty folder in the system's temporary folder, created when missing. */
export function ensureBacktestLlmWorkingDirectory(): string {
  const directory = path.join(tmpdir(), "iorio-backtest-llm-workdir");
  mkdirSync(directory, { recursive: true });
  return directory;
}
