import { describe, expect, it } from "vitest";
import { buildWebDynoStartNotice, readReleaseIdentityFromEnvironment } from "./webDynoStartNotice.js";

const v207 = { releaseVersion: "v207", commitSha: "ddd5ffa0aaaaaaaa" };
const v208 = { releaseVersion: "v208", commitSha: "00bdb332bbbbbbbb" };
const v209SameCode = { releaseVersion: "v209", commitSha: "00bdb332bbbbbbbb" };

describe("buildWebDynoStartNotice", () => {
  it("says deployed, version only, when the commit changed", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: v207, current: v208 })).toBe("🚀 API v208 deployed.");
  });

  it("says restarted, still the same version, when the release is the same", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: v208, current: v208 })).toBe("🔄 API restarted (still v208).");
  });

  it("says configuration change, same code, when only the release number moved", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: v208, current: v209SameCode })).toBe("⚙️ API v209: configuration change, same code as v208.");
  });

  it("says started when nothing was stored", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: null, current: v208 })).toBe("🟢 API v208 started.");
  });

  it("says version unknown when Heroku provides no release identity", () => {
    expect(buildWebDynoStartNotice({ subject: "API", previous: v208, current: null })).toBe("🟢 API started (version unknown).");
  });

  it("shows the App subject in upper case", () => {
    expect(buildWebDynoStartNotice({ subject: "App", previous: v207, current: v208 })).toBe("🚀 APP v208 deployed.");
  });
});

describe("readReleaseIdentityFromEnvironment", () => {
  it("needs both the release version and the commit", () => {
    expect(readReleaseIdentityFromEnvironment({ HEROKU_RELEASE_VERSION: "v208", HEROKU_SLUG_COMMIT: "00bdb332" })).toEqual({ releaseVersion: "v208", commitSha: "00bdb332" });
    expect(readReleaseIdentityFromEnvironment({ HEROKU_RELEASE_VERSION: "v208" })).toBeNull();
    expect(readReleaseIdentityFromEnvironment({})).toBeNull();
  });
});
