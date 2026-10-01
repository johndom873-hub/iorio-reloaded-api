import { describe, expect, it } from "vitest";
import { buildWebDynoStartNotice, readReleaseIdentityFromEnvironment } from "./webDynoStartNotice.js";

const v207 = { releaseVersion: "v207", commitSha: "ddd5ffa0aaaaaaaa" };
const v208 = { releaseVersion: "v208", commitSha: "00bdb332bbbbbbbb" };
const v209SameCode = { releaseVersion: "v209", commitSha: "00bdb332bbbbbbbb" };

describe("buildWebDynoStartNotice", () => {
  it("says deployed, with the previous release, when the commit changed", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: v207, current: v208, environmentLabel: "production" })).toBe(
      "🚀 API deployed: release v208, commit 00bdb33, production. Previous: release v207, commit ddd5ffa.",
    );
  });

  it("says restarted, no new release, when the release is the same", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: v208, current: v208, environmentLabel: "production" })).toBe("🔄 API restarted, no new release: release v208, commit 00bdb33, production.");
  });

  it("says a config/settings change, not a deploy, when only the release number moved", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: v208, current: v209SameCode, environmentLabel: "production" })).toBe(
      "⚙️ API new release v209 with the same code (commit 00bdb33), production: a config variable or settings change, not a deploy. Previous: release v208.",
    );
  });

  it("says first start on record when nothing was stored", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: null, current: v208, environmentLabel: "staging" })).toBe("🟢 API started: release v208, commit 00bdb33, staging. First start on record.");
  });

  it("says metadata unavailable when Heroku provides no release identity", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: v208, current: null, environmentLabel: "staging" })).toBe("🟢 API started (release metadata unavailable, staging).");
  });
});

describe("readReleaseIdentityFromEnvironment", () => {
  it("needs both the release version and the commit", () => {
    expect(readReleaseIdentityFromEnvironment({ HEROKU_RELEASE_VERSION: "v208", HEROKU_SLUG_COMMIT: "00bdb332" })).toEqual({ releaseVersion: "v208", commitSha: "00bdb332" });
    expect(readReleaseIdentityFromEnvironment({ HEROKU_RELEASE_VERSION: "v208" })).toBeNull();
    expect(readReleaseIdentityFromEnvironment({})).toBeNull();
  });
});
