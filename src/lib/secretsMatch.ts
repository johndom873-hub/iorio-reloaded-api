import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time comparison of a presented secret against the expected one (hashing first so lengths never leak). */
export function secretsMatch(presentedSecret: string, expectedSecret: string): boolean {
  const presentedDigest = createHash("sha256").update(presentedSecret).digest();
  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}
