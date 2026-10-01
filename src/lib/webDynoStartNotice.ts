// The Telegram message every API web dyno start sends. A promotion/deploy shows up as a new release version
// and commit; a plain restart repeats the previous ones. Both values come from Heroku's runtime-dyno-metadata
// feature and are "unknown" where it is off (local dev, or an app that has not enabled it).
export function buildWebDynoStartNotice(input: { commit: string | undefined; releaseVersion: string | undefined; environmentLabel: string }): string {
  const commit = input.commit?.slice(0, 7) || "unknown";
  const releaseVersion = input.releaseVersion || "unknown";
  return `🟢 API web dyno started (release ${releaseVersion}, commit ${commit}, ${input.environmentLabel}).`;
}
