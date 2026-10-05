import { db } from "../db/connection.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";

// The Telegram message a web dyno sends when it starts. It says WHICH kind of start this is, so nobody has to
// compare release numbers by hand: a deploy/promotion (new commit), a release with the same code (a config
// variable or settings change) or a plain restart (same release again: daily cycling, crash, manual restart).
// The environment is not in the text: staging and production post through different Telegram bots.
// The release identity comes from Heroku's runtime-dyno-metadata feature; the previous one from deploy_notice_state.

export interface ReleaseIdentity {
  releaseVersion: string;
  commitSha: string;
}

// Shown as upper case ("App" is stored as "APP v110 ..."): the subject is also the deploy_notice_state key, so it stays as is.
const displayName = (subject: string): string => subject.toUpperCase();

/** The identity Heroku reports for this dyno, or null where the metadata is off (local dev, an app without the feature). */
export function readReleaseIdentityFromEnvironment(environmentVariables: NodeJS.ProcessEnv = process.env): ReleaseIdentity | null {
  const releaseVersion = environmentVariables.HEROKU_RELEASE_VERSION;
  const commitSha = environmentVariables.HEROKU_SLUG_COMMIT;
  return releaseVersion && commitSha ? { releaseVersion, commitSha } : null;
}

// Wording is deliberately short and version-only: the commit is stored (it is how a deploy is told from a
// config change) but not shown, because what matters is that a new version came in.
export function buildWebDynoStartNotice(input: { subject: string; previous: ReleaseIdentity | null; current: ReleaseIdentity | null }): string {
  const { previous, current } = input;
  const name = displayName(input.subject);
  if (!current) return `🟢 ${name} started (version unknown).`;
  if (!previous) return `🟢 ${name} ${current.releaseVersion} started.`;
  if (previous.releaseVersion === current.releaseVersion) return `🔄 ${name} restarted (still ${current.releaseVersion}).`;
  if (previous.commitSha !== current.commitSha) return `🚀 ${name} ${current.releaseVersion} deployed.`;
  return `⚙️ ${name} ${current.releaseVersion}: configuration change, same code as ${previous.releaseVersion}.`;
}

/** Reads what this subject last announced, records the current release and sends the matching message. */
export async function announceWebDynoStart(input: {
  subject: string;
  current?: ReleaseIdentity | null;
  notify?: (message: string) => Promise<void>;
}): Promise<string> {
  const { subject } = input;
  const current = input.current === undefined ? readReleaseIdentityFromEnvironment() : input.current;
  const notify = input.notify ?? notifyTelegramTracked;

  // The start notice must go out even when the database cannot answer (the very situation a restart may be reporting).
  let previous: ReleaseIdentity | null = null;
  let stateProblem: string | null = null;
  if (current) {
    try {
      const row: { release_version: string; commit_sha: string } | undefined = await db("deploy_notice_state").where({ subject }).first("release_version", "commit_sha");
      previous = row ? { releaseVersion: row.release_version, commitSha: row.commit_sha } : null;
      await db("deploy_notice_state")
        .insert({ subject, release_version: current.releaseVersion, commit_sha: current.commitSha })
        .onConflict("subject")
        .merge({ release_version: current.releaseVersion, commit_sha: current.commitSha, updated_at: db.fn.now() });
    } catch (error) {
      // Database errors lead with the whole SQL statement; only the reason after it belongs in a Telegram message.
      const errorText = error instanceof Error ? error.message : String(error);
      stateProblem = errorText.slice(errorText.lastIndexOf(" - ") + 3).slice(0, 120);
    }
  }

  const message = stateProblem
    ? `🟢 ${displayName(subject)} ${current ? `${current.releaseVersion} ` : ""}started (could not tell deploy from restart: ${stateProblem}).`
    : buildWebDynoStartNotice({ subject, previous, current });
  await notify(message);
  return message;
}
