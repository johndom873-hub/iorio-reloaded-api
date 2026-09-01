import { requireEnvironmentVariable } from "../config/env.js";

// Cloudflare WAF custom rules for the ioriore.com zone, used by Genosuke to
// block/unblock attackers on request. Ported from menaris-admin-api's
// cloudflare-service.js (used by "Jack") -- same API shapes, adapted to
// this codebase's plain-fetch convention instead of axios. Token is
// zone-scoped (Zone:WAF Edit + Zone:Zone Read only, created 2026-09-01) --
// see .env CLOUDFLARE_* vars.
const BASE_URL = "https://api.cloudflare.com/client/v4";

interface CloudflareApiResponse<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

interface CloudflareRule {
  id: string;
  description: string;
  expression: string;
  action: string;
  enabled: boolean;
  action_parameters?: unknown;
}

interface CloudflareRuleset {
  id: string | null;
  rules: CloudflareRule[];
}

// Cloudflare error code for "this zone has never had a custom-rules ruleset
// created" -- a brand-new zone (like ioriore.com, confirmed 2026-09-01) has
// no http_request_firewall_custom entrypoint at all until the first rule is
// ever added to it, unlike menaris's zone (already had a pre-existing rule
// when Jack's cloudflare-service.js was written, so this case never came
// up there). Matched on the numeric code, not the message text, since
// Cloudflare's error messages aren't a documented stable contract.
const RULESET_NOT_FOUND_CODE = 10003;

class CloudflareApiError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
  ) {
    super(message);
  }
}

async function cloudflareRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const apiToken = requireEnvironmentVariable("CLOUDFLARE_API_TOKEN");
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json()) as CloudflareApiResponse<T>;
  if (!data.success) {
    const firstError = data.errors?.[0];
    throw new CloudflareApiError(firstError?.message ?? `Cloudflare API error (HTTP ${response.status})`, firstError?.code ?? null);
  }
  return data.result;
}

// The zone is on Cloudflare's Free plan, which caps custom WAF rules at 5 --
// one rule per blocked IP would hit that ceiling after 4 blocks. All plain
// IP-block rules are consolidated into a single shared rule under this
// description instead, so blocking N IPs only ever costs one rule slot.
const IP_BLOCKLIST_DESCRIPTION = "blocked-ips (shared IP blocklist)";

function parseIpSet(expression: string): Set<string> | null {
  const single = expression.match(/^\(ip\.src eq ([\da-fA-F:.]+)\)$/);
  if (single) return new Set([single[1]!]);
  const multi = expression.match(/^\(ip\.src in \{([^}]*)\}\)$/);
  if (multi) return new Set(multi[1]!.trim().split(/\s+/).filter(Boolean));
  return null;
}

function buildIpExpression(ips: Set<string>): string {
  const list = [...ips];
  return list.length === 1 ? `(ip.src eq ${list[0]})` : `(ip.src in {${list.join(" ")}})`;
}

// The custom-rules ruleset is auto-created by Cloudflare the first time a
// rule is added to this phase; always fetched fresh rather than cached. A
// zone with no custom rules yet (RULESET_NOT_FOUND_CODE) has no ruleset id
// to POST/PATCH/DELETE rules against -- callers that mutate must branch on
// `ruleset.id === null` and use createRulesetWithRule below instead.
//
// A ruleset that exists but currently has zero rules (e.g. right after the
// last rule was deleted -- confirmed live 2026-09-01) omits the `rules`
// field from the response entirely rather than returning `[]`, so it's
// normalized here once rather than every caller needing `?? []`.
async function getCustomRuleset(): Promise<CloudflareRuleset> {
  const zoneId = requireEnvironmentVariable("CLOUDFLARE_ZONE_ID");
  try {
    const ruleset = await cloudflareRequest<CloudflareRuleset>(`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`);
    return { ...ruleset, rules: ruleset.rules ?? [] };
  } catch (err) {
    if (err instanceof CloudflareApiError && err.code === RULESET_NOT_FOUND_CODE) return { id: null, rules: [] };
    throw err;
  }
}

// Creates the zone's custom-rules ruleset for the first time, with exactly
// one rule in it -- the PUT-entrypoint endpoint both creates the ruleset
// (if absent) and sets its rules in one call, unlike POST .../rules, which
// requires an existing ruleset id to append to.
async function createRulesetWithRule(rule: { action: string; expression: string; description: string; action_parameters?: unknown }): Promise<CloudflareRule> {
  const zoneId = requireEnvironmentVariable("CLOUDFLARE_ZONE_ID");
  const created = await cloudflareRequest<CloudflareRuleset>(`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`, {
    method: "PUT",
    body: JSON.stringify({ rules: [rule] }),
  });
  return created.rules[created.rules.length - 1]!;
}

export interface WafRuleSummary {
  id: string;
  description: string;
  expression: string;
  action: string;
  enabled: boolean;
}

export async function listWafRules(): Promise<WafRuleSummary[]> {
  const ruleset = await getCustomRuleset();
  return ruleset.rules.map((r) => ({ id: r.id, description: r.description, expression: r.expression, action: r.action, enabled: r.enabled }));
}

export interface AddWafRuleInput {
  expression: string;
  description: string;
  action?: string;
  actionParameters?: unknown;
}

export async function addWafRule({ expression, description, action = "block", actionParameters }: AddWafRuleInput): Promise<WafRuleSummary> {
  const zoneId = requireEnvironmentVariable("CLOUDFLARE_ZONE_ID");
  const ruleset = await getCustomRuleset();

  // Plain IP-only block expressions (single `eq` or multi `in {}`) merge
  // into the shared blocklist rule instead of creating a new one.
  const newIps = action === "block" && !actionParameters ? parseIpSet(expression) : null;
  if (newIps) {
    const existing = ruleset.rules.find((r) => r.description === IP_BLOCKLIST_DESCRIPTION);
    if (existing) {
      const ips = parseIpSet(existing.expression) ?? new Set<string>();
      for (const ip of newIps) ips.add(ip);
      return updateWafRule(existing.id, { expression: buildIpExpression(ips) });
    }
    if (ruleset.id === null) {
      const newRule = await createRulesetWithRule({ action, expression: buildIpExpression(newIps), description: IP_BLOCKLIST_DESCRIPTION });
      return { id: newRule.id, description: IP_BLOCKLIST_DESCRIPTION, expression: newRule.expression, action, enabled: true };
    }
    const updatedRuleset = await cloudflareRequest<CloudflareRuleset>(`/zones/${zoneId}/rulesets/${ruleset.id}/rules`, {
      method: "POST",
      body: JSON.stringify({ action, expression: buildIpExpression(newIps), description: IP_BLOCKLIST_DESCRIPTION, enabled: true }),
    });
    const newRule = updatedRuleset.rules[updatedRuleset.rules.length - 1]!;
    return { id: newRule.id, description: IP_BLOCKLIST_DESCRIPTION, expression: newRule.expression, action, enabled: true };
  }

  if (ruleset.id === null) {
    const newRule = await createRulesetWithRule({ action, expression, description, ...(actionParameters ? { action_parameters: actionParameters } : {}) });
    return { id: newRule.id, description, expression, action, enabled: true };
  }

  const updatedRuleset = await cloudflareRequest<CloudflareRuleset>(`/zones/${zoneId}/rulesets/${ruleset.id}/rules`, {
    method: "POST",
    body: JSON.stringify({ action, ...(actionParameters ? { action_parameters: actionParameters } : {}), expression, description, enabled: true }),
  });
  // This endpoint returns the whole updated ruleset, not the created rule --
  // the new rule is always the last entry since Cloudflare appends on create.
  const newRule = updatedRuleset.rules[updatedRuleset.rules.length - 1]!;
  return { id: newRule.id, description, expression, action, enabled: true };
}

// Companion to the consolidation in addWafRule -- removes a single IP from
// the shared blocklist rule (deleting the rule entirely if it was the last
// IP), instead of needing a ruleId to unblock one address out of a merged set.
export async function unblockIp(ip: string): Promise<{ removed: boolean; reason?: string; ip?: string; ruleDeleted?: boolean; remainingIps?: string[] }> {
  const zoneId = requireEnvironmentVariable("CLOUDFLARE_ZONE_ID");
  const ruleset = await getCustomRuleset();
  const existing = ruleset.rules.find((r) => r.description === IP_BLOCKLIST_DESCRIPTION);
  if (!existing) return { removed: false, reason: "No shared IP blocklist rule found." };
  const ips = parseIpSet(existing.expression) ?? new Set<string>();
  if (!ips.has(ip)) return { removed: false, reason: `${ip} is not currently blocked.` };
  ips.delete(ip);
  if (ips.size === 0) {
    await cloudflareRequest(`/zones/${zoneId}/rulesets/${ruleset.id}/rules/${existing.id}`, { method: "DELETE" });
    return { removed: true, ip, ruleDeleted: true };
  }
  await updateWafRule(existing.id, { expression: buildIpExpression(ips) });
  return { removed: true, ip, remainingIps: [...ips] };
}

export interface UpdateWafRuleInput {
  expression?: string;
  description?: string;
  action?: string;
  actionParameters?: unknown;
}

// Cloudflare's rule PATCH is not a true partial update -- omitted fields are
// sent as blank rather than left untouched, which silently wipes them
// (description) or gets rejected (a blank expression). Always merge onto
// the rule's current values fetched fresh above.
export async function updateWafRule(ruleId: string, { expression, description, action, actionParameters }: UpdateWafRuleInput): Promise<WafRuleSummary> {
  const zoneId = requireEnvironmentVariable("CLOUDFLARE_ZONE_ID");
  const ruleset = await getCustomRuleset();
  const current = ruleset.rules.find((r) => r.id === ruleId);
  if (!current) throw new Error(`No WAF rule found with id ${ruleId}`);
  const merged = {
    action: action ?? current.action,
    expression: expression ?? current.expression,
    description: description ?? current.description,
    ...((actionParameters ?? current.action_parameters) ? { action_parameters: actionParameters ?? current.action_parameters } : {}),
  };
  await cloudflareRequest(`/zones/${zoneId}/rulesets/${ruleset.id}/rules/${ruleId}`, { method: "PATCH", body: JSON.stringify(merged) });
  return { id: ruleId, description: merged.description, expression: merged.expression, action: merged.action, enabled: true };
}

export async function removeWafRule(ruleId: string): Promise<{ removed: string }> {
  const zoneId = requireEnvironmentVariable("CLOUDFLARE_ZONE_ID");
  const ruleset = await getCustomRuleset();
  await cloudflareRequest(`/zones/${zoneId}/rulesets/${ruleset.id}/rules/${ruleId}`, { method: "DELETE" });
  return { removed: ruleId };
}
