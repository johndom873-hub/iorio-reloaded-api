// Infra-write tools — same Yes/Cancel Telegram confirm gate as
// financial-write (see chat.ts), but for infrastructure/security actions
// rather than trading. Currently just Cloudflare WAF custom-rule changes on
// the ioriore.com zone (blocking/unblocking an attacker's IP or traffic
// pattern) — added 2026-09-01, ported from menaris-admin-api's "Jack"
// (analyst-agent-service.js's list_waf_rules/add_waf_rule/remove_waf_rule/
// unblock_ip). Jack relies purely on a system-prompt instruction to ask
// before calling add_waf_rule; here it's a real confirm button instead,
// same reasoning as financial-write's departure from Jack (approved
// 2026-08-21) — a rule change hits live production traffic immediately and
// a mistaken expression could block real users, not just cost a bad
// database record.
import { addWafRule, removeWafRule, unblockIp } from "../../lib/cloudflareService.js";
import type { GenosukeTool } from "./types.js";

export const infraWriteTools: GenosukeTool[] = [
  {
    name: "add_waf_rule",
    description:
      "Add a Cloudflare WAF custom rule on the ioriore.com zone — e.g. to block an attacker's IP. This affects live production traffic immediately, so always state the exact expression back to the human and get explicit confirmation before calling this (the Yes/Cancel prompt this tier triggers IS that confirmation — still describe what you're about to do in your own message first). `expression` must be valid Cloudflare Rules language — IP literals are UNQUOTED: (ip.src eq 1.2.3.4) for a single IP, (ip.src in {1.2.3.4 5.6.7.8}) for multiple IPs; string literals ARE quoted: (http.request.uri.path contains \"/some-path\") for a path. Plain IP-block expressions automatically merge into a single shared blocklist rule (the zone is on a Free plan, capped at 5 custom rules total) — use unblock_ip, not remove_waf_rule, to undo a plain IP block.",
    tier: "infra-write",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Cloudflare Rules language filter expression identifying the traffic to act on." },
        description: { type: "string", description: "Short human-readable label for the rule, e.g. 'block scanner 8.208.53.58'." },
        action: { type: "string", enum: ["block", "challenge", "js_challenge", "managed_challenge"], description: "Defaults to 'block' if omitted." },
      },
      required: ["expression", "description"],
    },
    describeForConfirmation: (input) => `Add Cloudflare WAF rule on ioriore.com: ${input.expression} → ${input.action ?? "block"} ("${input.description}")`,
    execute: (input) => addWafRule({ expression: String(input.expression), description: String(input.description), action: input.action as string | undefined }),
  },
  {
    name: "remove_waf_rule",
    description:
      "Remove (unblock) a Cloudflare WAF custom rule on the ioriore.com zone by its rule id. Do NOT use this to unblock a single IP that was added via add_waf_rule/unblock_ip — those IPs share one merged rule, so deleting the rule by id would unblock every IP in it at once. Use unblock_ip for that instead. Call list_waf_rules first if you need to look up the id from a description.",
    tier: "infra-write",
    parameters: { type: "object", properties: { ruleId: { type: "string" } }, required: ["ruleId"] },
    describeForConfirmation: (input) => `Remove Cloudflare WAF rule ${input.ruleId} on ioriore.com`,
    execute: (input) => removeWafRule(String(input.ruleId)),
  },
  {
    name: "unblock_ip",
    description:
      "Remove a single IP from the shared IP blocklist rule created by add_waf_rule (removes just that IP, leaving other blocked IPs in place; deletes the rule entirely if it was the last IP). This is the correct way to unblock one IP — do not use remove_waf_rule for this.",
    tier: "infra-write",
    parameters: { type: "object", properties: { ip: { type: "string" } }, required: ["ip"] },
    describeForConfirmation: (input) => `Unblock IP ${input.ip} on ioriore.com's Cloudflare WAF`,
    execute: (input) => unblockIp(String(input.ip)),
  },
];
