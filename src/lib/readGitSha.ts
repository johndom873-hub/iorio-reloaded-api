import { execFileSync } from "node:child_process";

/**
 * The commit this process's checkout is on (the VPS worker runs from a git
 * checkout). Fails soft: observation must never crash the worker, so a missing
 * .git or git binary yields null plus a warning.
 */
export function readGitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch (error) {
    console.warn(`Could not read the git SHA: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
