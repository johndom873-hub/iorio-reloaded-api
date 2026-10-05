import { notifyTelegram } from "./notifyTelegram.js";
import { wasErrorAlerted } from "./runJob.js";

const failureAlertTimeoutMs = 15_000;

/** An AggregateError (a refused connection) has an empty message: fall back to its code or name so the alert is never blank. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return error.message || (typeof code === "string" ? code : "") || error.name;
}

/**
 * Entry-point wrapper for scheduled scripts. An error thrown outside runJob (the market-closed
 * guard's database read, env validation, anything before the job row exists) would otherwise
 * only reach console.error and a non-zero exit code, which Heroku Scheduler does not alert on.
 * An error runJob already reported is not reported twice.
 */
export async function runScript(scriptName: string, main: () => Promise<void>, cleanup: () => Promise<unknown>): Promise<void> {
  try {
    await main();
  } catch (error) {
    const message = describeError(error);
    console.error(message);
    process.exitCode = 1;
    if (!wasErrorAlerted(error)) {
      const firstLine = message.split("\n")[0]!.slice(0, 300);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, failureAlertTimeoutMs);
      });
      await Promise.race([notifyTelegram(`⚠️ ${scriptName} failed outside job tracking, so no job run was recorded: ${firstLine}`), timeout]);
      clearTimeout(timer);
    }
  } finally {
    await cleanup();
  }
}
