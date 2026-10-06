// The model's output contract (design round 3, item 24, approved 2026-09-28). The model never
// authors a strike, an expiry, a quantity, a size or a price: it names one of the ids the round offered and
// its reasons; code sizes every order to the standard order size. Anything that does not parse is a no_trade.
// The JSON schema is sent to OpenRouter as a strict response_format AND re-validated here —
// server-side enforcement varies by model, client-side validation does not.

export type PlutoDecisionVerdict = "trade" | "no_trade" | "abstain_system_concern";
export type PlutoDecisionActionKind = "open_covered_call" | "open_cash_secured_put" | "roll" | "close_shares" | "close_leg";

export interface PlutoDecision {
  decision: PlutoDecisionVerdict;
  actionKind: PlutoDecisionActionKind | null;
  candidateId: string | null;
  confidence: number;
  reasons: string[];
  risksAcknowledged: string[];
  systemConcerns: string[];
}

export const plutoDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "action_kind", "candidate_id", "confidence", "reasons", "risks_acknowledged", "system_concerns"],
  properties: {
    decision: { type: "string", enum: ["trade", "no_trade", "abstain_system_concern"] },
    action_kind: { type: ["string", "null"], enum: ["open_covered_call", "open_cash_secured_put", "roll", "close_shares", "close_leg", null] },
    candidate_id: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasons: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    risks_acknowledged: { type: "array", items: { type: "string" }, maxItems: 10 },
    system_concerns: { type: "array", items: { type: "string" }, maxItems: 10 },
  },
} as const;

const verdicts = new Set<string>(["trade", "no_trade", "abstain_system_concern"]);
const actionKinds = new Set<string>(["open_covered_call", "open_cash_secured_put", "roll", "close_shares", "close_leg"]);

export type ParsedPlutoDecision = { ok: true; decision: PlutoDecision } | { ok: false; error: string };

function stringArray(value: unknown, name: string, max: number, min = 0): string[] | string {
  if (!Array.isArray(value)) return `${name} must be an array`;
  if (value.length < min) return `${name} needs at least ${min} entr${min === 1 ? "y" : "ies"}`;
  if (value.length > max) return `${name} has more than ${max} entries`;
  if (!value.every((entry) => typeof entry === "string")) return `${name} must contain strings only`;
  return value as string[];
}

/**
 * Parses and validates the model's text. `offeredIds` are the ids this pass put in front of the model;
 * a trade naming anything else is invalid, never "close enough".
 */
export function parsePlutoDecision(rawText: string, offeredIds: ReadonlySet<string>): ParsedPlutoDecision {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonObject(rawText));
  } catch (error) {
    return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, error: "top level is not an object" };
  const object = json as Record<string, unknown>;

  const decision = object.decision;
  if (typeof decision !== "string" || !verdicts.has(decision)) return { ok: false, error: "decision must be trade, no_trade or abstain_system_concern" };
  const actionKind = object.action_kind ?? null;
  if (actionKind !== null && (typeof actionKind !== "string" || !actionKinds.has(actionKind))) return { ok: false, error: "action_kind is not a known kind" };
  const candidateId = object.candidate_id ?? null;
  if (candidateId !== null && typeof candidateId !== "string") return { ok: false, error: "candidate_id must be a string or null" };
  const confidence = object.confidence;
  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) return { ok: false, error: "confidence must be a number between 0 and 1" };
  const reasons = stringArray(object.reasons, "reasons", 5, 1);
  if (typeof reasons === "string") return { ok: false, error: reasons };
  const risks = stringArray(object.risks_acknowledged ?? [], "risks_acknowledged", 10);
  if (typeof risks === "string") return { ok: false, error: risks };
  const concerns = stringArray(object.system_concerns ?? [], "system_concerns", 10);
  if (typeof concerns === "string") return { ok: false, error: concerns };

  if (decision === "trade") {
    if (actionKind === null) return { ok: false, error: "a trade needs an action_kind" };
    if (candidateId === null) return { ok: false, error: "a trade needs a candidate_id" };
    if (!offeredIds.has(candidateId)) return { ok: false, error: `candidate_id ${candidateId} was not offered this pass` };
    const expectedKind = kindFromCandidateId(candidateId);
    if (expectedKind && expectedKind !== actionKind) return { ok: false, error: `action_kind ${actionKind} does not match candidate ${candidateId}` };
  }

  return {
    ok: true,
    decision: {
      decision: decision as PlutoDecisionVerdict,
      actionKind: (decision === "trade" ? actionKind : null) as PlutoDecisionActionKind | null,
      candidateId: decision === "trade" ? (candidateId as string) : null,
      confidence,
      reasons,
      risksAcknowledged: risks,
      systemConcerns: concerns,
    },
  };
}

/** Ids are self-describing (symbol:kind:...), so the action kind can be cross-checked against the id. */
export function kindFromCandidateId(id: string): PlutoDecisionActionKind | null {
  const kind = id.split(":")[1];
  if (kind === "cash_secured_put") return "open_cash_secured_put";
  if (kind === "covered_call") return "open_covered_call";
  if (kind === "roll") return "roll";
  if (kind === "close_shares") return "close_shares";
  if (kind === "close_leg") return "close_leg";
  return null;
}

/** Tolerates a model that wraps its JSON in a code fence or prose; the first balanced object wins. */
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return trimmed;
  return trimmed.slice(start, end + 1);
}

/** Two calls agree when they reach the same verdict on the same candidate. */
export function reconcileAgreement(first: PlutoDecision, second: PlutoDecision): { agreed: boolean; decision: PlutoDecision; detail: string } {
  if (first.decision !== second.decision) return { agreed: false, decision: noTrade(`calls disagree on the verdict (${first.decision} vs ${second.decision})`), detail: "verdict mismatch" };
  if (first.decision !== "trade") return { agreed: true, decision: first, detail: `both ${first.decision}` };
  if (first.candidateId !== second.candidateId) return { agreed: false, decision: noTrade(`calls disagree on the candidate (${first.candidateId} vs ${second.candidateId})`), detail: "candidate mismatch" };
  return {
    agreed: true,
    decision: { ...first, confidence: Math.min(first.confidence, second.confidence), reasons: first.reasons, risksAcknowledged: [...new Set([...first.risksAcknowledged, ...second.risksAcknowledged])] },
    detail: `both trade ${first.candidateId}`,
  };
}

export function noTrade(reason: string): PlutoDecision {
  return { decision: "no_trade", actionKind: null, candidateId: null, confidence: 1, reasons: [reason], risksAcknowledged: [], systemConcerns: [] };
}
