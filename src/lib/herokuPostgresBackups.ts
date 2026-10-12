// Heroku Postgres backup + restore for the release phase (scripts/run-release-phase.ts). The same
// endpoints the Heroku CLI's pg:backups:capture / pg:backups:restore call (heroku CLI 11.10,
// dist/commands/pg/backups/*.js): the Platform API resolves the DATABASE attachment to its add-on,
// the data API (api.data.heroku.com) runs the transfer. The API key is used for nothing else and is
// never printed.

const platformApiHost = "https://api.heroku.com";
const dataApiHost = "https://api.data.heroku.com";
const transferPollIntervalMs = 3_000;

export interface HerokuPostgresTransfer {
  uuid: string;
  num: number;
  succeeded: boolean;
  finished_at: string | null;
  to_url: string | null;
}

export interface HerokuBackupsClient {
  apiKey: string;
  appName: string;
}

async function herokuRequest<T>(client: HerokuBackupsClient, url: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.heroku+json; version=3",
      Authorization: `Basic ${Buffer.from(`:${client.apiKey}`).toString("base64")}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Heroku API ${method} ${new URL(url).pathname} answered ${response.status}: ${detail}`);
  }
  return (await response.json()) as T;
}

/** The add-on id of the app's DATABASE attachment (the data API addresses databases by add-on). */
export async function resolveDatabaseAddonId(client: HerokuBackupsClient): Promise<string> {
  const attachment = await herokuRequest<{ addon: { id: string } }>(client, `${platformApiHost}/apps/${client.appName}/addon-attachments/DATABASE`, "GET");
  return attachment.addon.id;
}

/** Heroku's own backup name for a transfer, e.g. "b023" (manual) as `heroku pg:backups` lists it. */
export function herokuBackupName(transfer: Pick<HerokuPostgresTransfer, "num">): string {
  return `b${String(transfer.num).padStart(3, "0")}`;
}

async function waitForTransfer(client: HerokuBackupsClient, transferUuid: string, timeoutMs: number, what: string): Promise<HerokuPostgresTransfer> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const transfer = await herokuRequest<HerokuPostgresTransfer>(client, `${dataApiHost}/client/v11/apps/${client.appName}/transfers/${transferUuid}`, "GET");
    if (transfer.finished_at) {
      if (!transfer.succeeded) throw new Error(`${what} (transfer ${transfer.num}) finished without succeeding (see heroku pg:backups)`);
      return transfer;
    }
    if (Date.now() > deadline) throw new Error(`${what} (transfer ${transfer.num}) did not finish within ${Math.round(timeoutMs / 1000)} s`);
    await new Promise((resolve) => setTimeout(resolve, transferPollIntervalMs));
  }
}

export async function captureDatabaseBackup(client: HerokuBackupsClient, databaseAddonId: string, timeoutMs: number): Promise<HerokuPostgresTransfer> {
  const started = await herokuRequest<HerokuPostgresTransfer>(client, `${dataApiHost}/client/v11/databases/${databaseAddonId}/backups`, "POST");
  return waitForTransfer(client, started.uuid, timeoutMs, "Backup");
}

export async function restoreDatabaseBackup(client: HerokuBackupsClient, databaseAddonId: string, backup: HerokuPostgresTransfer, timeoutMs: number): Promise<void> {
  if (!backup.to_url) throw new Error(`Backup ${herokuBackupName(backup)} has no stored file to restore from`);
  const started = await herokuRequest<HerokuPostgresTransfer>(client, `${dataApiHost}/client/v11/databases/${databaseAddonId}/restores`, "POST", { backup_url: backup.to_url });
  await waitForTransfer(client, started.uuid, timeoutMs, "Restore");
}
