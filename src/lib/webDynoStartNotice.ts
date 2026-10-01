import { db } from "../db/connection.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";

// The Telegram message a web dyno sends when it starts. It says WHICH kind of start this is, so nobody has to
// compare release numbers by hand: a deploy/promotion (new commit), a release with the same code (a config
// variable or settings change) or a plain restart (same release again: daily cycling, crash, manual restart).
// The release identity comes from Heroku's runtime-dyno-metadata feature; the previous one from deploy_notice_state.

export interface ReleaseIdentity {
  releaseVersion: string;
  commitSha: string;
}

const shortCommit = (commitSha: string): string => commitSha.slice(0, 7);
const describeRelease = (release: ReleaseIdentity): string => `release ${release.releaseVersion}, commit ${shortCommit(release.commitSha)}`;

/** The identity Heroku reports for this dyno, or null where the metadata is off (local dev, an app without the feature). */
export function readReleaseIdentityFromEnvironment(environmentVariables: NodeJS.ProcessEnv = process.env): ReleaseIdentity | null {
  const releaseVersion = environmentVariables.HEROKU_RELEASE_VERSION;
  const commitSha = environmentVariables.HEROKU_SLUG_COMMIT;
  return releaseVersion && commitSha ? { releaseVersion, commitSha } : null;
}

export function buildWebDynoStartNotice(input: { subject: string; previous: ReleaseIdentity | null; current: ReleaseIdentity | null; environmentLabel: string }): string {
  const { subject, previous, current, environmentLabel } = input;
  if (!current) return `🟢 ${subject} started (release metadata unavailable, ${environmentLabel}).`;
  if (!previous) return `🟢 ${subject} started: ${describeRelease(current)}, ${environmentLabel}. First start on record.`;
  if (previous.releaseVersion === current.releaseVersion) return `🔄 ${subject} restarted, no new release: ${describeRelease(current)}, ${environmentLabel}.`;
  if (previous.commitSha !== current.commitSha) return `🚀 ${subject} deployed: ${describeRelease(current)}, ${environmentLabel}. Previous: ${describeRelease(previous)}.`;
  return `⚙️ ${subject} new release ${current.releaseVersion} with the same code (commit ${shortCommit(current.commitSha)}), ${environmentLabel}: a config variable or settings change, not a deploy. Previous: release ${previous.releaseVersion}.`;
}

/** Reads what this subject last announced, records the current release and sends the matching message. */
export async function announceWebDynoStart(input: {
  subject: string;
  environmentLabel: string;
  current?: ReleaseIdentity | null;
  notify?: (message: string) => Promise<void>;
}): Promise<string> {
  const { subject, environmentLabel } = input;
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
      stateProblem = error instanceof Error ? error.message : String(error);
    }
  }

  const message = stateProblem
    ? `🟢 ${subject} started: ${current ? describeRelease(current) : "release unknown"}, ${environmentLabel}. Could not tell whether this is a deploy or a restart (previous release unreadable: ${stateProblem}).`
    : buildWebDynoStartNotice({ subject, previous, current, environmentLabel });
  await notify(message);
  return message;
}
