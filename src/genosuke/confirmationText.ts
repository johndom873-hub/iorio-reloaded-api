// Leg annotation for the position results Genosuke's read tools hand the
// model (readTools.ts). Pure function (no API calls) so it's unit tested.

/** Adds isOpen to each leg so the model never has to infer it from exitAt. Non-position values pass through. */
export function annotateLegOpenState<T>(value: T): T {
  if (Array.isArray(value)) return value.map(annotateLegOpenState) as T;
  if (value && typeof value === "object" && Array.isArray((value as { legs?: unknown }).legs)) {
    const position = value as unknown as { legs: { exitAt?: string | null }[] };
    return { ...position, legs: position.legs.map((leg) => ({ ...leg, isOpen: !leg.exitAt })) } as T;
  }
  return value;
}
