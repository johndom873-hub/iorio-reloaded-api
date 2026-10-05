import { execFileSync } from "node:child_process";

/**
 * The commit this process's checkout is on (the VPS worker runs from a git
 * checkout). Fails soft: observation must never crash the worker, so a missing
 * .git or git binary yields null plus a warning.
 *
 * Read once per process: the commit cannot change while it runs, and the heartbeat loops call this every
 * minute (the web dyno has no git binary, so an uncached call forks and warns every time).
 */
let cachedGitSha: string | null | undefined;

export function readGitSha(): string | null {
  if (cachedGitSha !== undefined) return cachedGitSha;
  try {
    cachedGitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch (error) {
    console.warn(`Could not read the git SHA: ${error instanceof Error ? error.message : error}`);
    cachedGitSha = null;
  }
  return cachedGitSha;
}
