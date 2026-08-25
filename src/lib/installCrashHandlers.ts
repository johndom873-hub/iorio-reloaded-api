import { notifyTelegram } from "./notifyTelegram.js";

// Node already crashes the process on an uncaught exception by default (and
// an unhandled rejection is heading the same direction in future Node
// versions), so this doesn't change that outcome -- see PROGRESS.md's
// "global safety net" entry for why NOT trying to keep the process alive
// afterward is deliberate: an uncaught error leaves the process in an
// unknown state (a half-finished DB write, a leftover IBKR listener), and
// Heroku/systemd already restart a crashed process cleanly on their own.
// This exists purely to make the crash diagnosable -- a clean Telegram
// alert plus a full stack trace in the logs, instead of an unexplained
// dyno/service restart with no trail. Root-caused by two real crashes
// found building the Ticker Detail modal (writing to a disconnected SSE
// response; an unawaited promise rejecting before its own try/catch ran) --
// both fixed locally, but nothing caught the *next* one.
const notifyTimeoutMs = 5_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return Promise.race([promise, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

export function installCrashHandlers(processName: string): void {
  function handleFatal(kind: "uncaughtException" | "unhandledRejection", error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const timestamp = new Date().toISOString();
    const uptimeSeconds = Math.round(process.uptime());

    // Full stack trace goes to stderr (captured by Heroku/journalctl) --
    // the one piece of information actually needed to root-cause this,
    // which a blank "dyno restarted" log line doesn't give you.
    console.error(`[FATAL ${kind}] ${processName} at ${timestamp} (uptime ${uptimeSeconds}s)\n${err.stack ?? err.message}`);

    const summary = `🔥 ${processName} crashed (${kind}) after ${uptimeSeconds}s uptime:\n${err.message}\n\nFull stack trace in the logs.`;
    withTimeout(notifyTelegram(summary), notifyTimeoutMs).finally(() => process.exit(1));
  }

  process.on("uncaughtException", (error) => handleFatal("uncaughtException", error));
  process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
}
