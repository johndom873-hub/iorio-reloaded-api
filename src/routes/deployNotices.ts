import type { Request, Response } from "express";
import { announceWebDynoStart, type ReleaseIdentity } from "../lib/webDynoStartNotice.js";
import { secretsMatch } from "../lib/secretsMatch.js";

// Lets the frontend app's server announce its own start through the API, so both services use the same
// deployed / config-change / restart logic, the same state table and the same Telegram bot (the app has
// neither a database nor Telegram credentials). No session: authenticated by a shared secret header instead.
// The secret is read per request so a missing value fails closed with a clear 503 rather than stopping the
// API from booting.

export const deployNoticeSecretHeader = "X-Deploy-Notice-Secret";
const frontendSubject = "App";

interface DeployNoticeDependencies {
  readExpectedSecret: () => string | undefined;
  announce: (input: { subject: string; current: ReleaseIdentity | null }) => Promise<unknown>;
}

const defaultDependencies: DeployNoticeDependencies = {
  readExpectedSecret: () => process.env.DEPLOY_NOTICE_SECRET,
  announce: announceWebDynoStart,
};

function readReleaseIdentity(body: unknown): ReleaseIdentity | null {
  const { releaseVersion, commitSha } = (body ?? {}) as { releaseVersion?: unknown; commitSha?: unknown };
  return typeof releaseVersion === "string" && releaseVersion && typeof commitSha === "string" && commitSha ? { releaseVersion, commitSha } : null;
}

export function createDeployNoticeHandler(dependencies: DeployNoticeDependencies = defaultDependencies) {
  return async function handleDeployNotice(request: Request, response: Response): Promise<void> {
    const expectedSecret = dependencies.readExpectedSecret();
    if (!expectedSecret) {
      response.status(503).json({ error: "DEPLOY_NOTICE_SECRET is not configured on the API." });
      return;
    }
    if (!secretsMatch(request.get(deployNoticeSecretHeader) ?? "", expectedSecret)) {
      response.sendStatus(401);
      return;
    }
    await dependencies.announce({ subject: frontendSubject, current: readReleaseIdentity(request.body) });
    response.sendStatus(204);
  };
}

export const handleDeployNotice = createDeployNoticeHandler();
