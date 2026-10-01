import { describe, expect, it } from "vitest";
import { buildWebDynoStartNotice } from "./webDynoStartNotice.js";

describe("buildWebDynoStartNotice", () => {
  it("shows the release version, the short commit and the environment", () => {
    expect(buildWebDynoStartNotice({ commit: "00bdb332a1c4f9e0", releaseVersion: "v208", environmentLabel: "production" })).toBe("🟢 API web dyno started (release v208, commit 00bdb33, production).");
  });

  it("says unknown for values Heroku does not provide", () => {
    expect(buildWebDynoStartNotice({ commit: undefined, releaseVersion: undefined, environmentLabel: "staging" })).toBe("🟢 API web dyno started (release unknown, commit unknown, staging).");
    expect(buildWebDynoStartNotice({ commit: "", releaseVersion: "", environmentLabel: "staging" })).toBe("🟢 API web dyno started (release unknown, commit unknown, staging).");
  });
});
