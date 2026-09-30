import { describe, expect, it } from "vitest";
import { describeFreshLoginResult, parseGatewayControlResultKind } from "./gatewayControlResult.js";

describe("parseGatewayControlResultKind", () => {
  it("reads the result line after the script's other output", () => {
    const output = "=== gateway-control fresh-login live: 2026-09-30T05:00:00Z ===\nrestarting iorio-ibkr-ib-gateway-live-1 for a fresh login\nGATEWAY_CONTROL_RESULT=waiting_for_2fa\n";
    expect(parseGatewayControlResultKind(output)).toBe("waiting_for_2fa");
  });

  it("takes the last result line when there is more than one", () => {
    expect(parseGatewayControlResultKind("GATEWAY_CONTROL_RESULT=rate_limited\nGATEWAY_CONTROL_RESULT=login_completed\n")).toBe("login_completed");
  });

  it("returns null when the script printed no result", () => {
    expect(parseGatewayControlResultKind("Permission denied (publickey).\n")).toBeNull();
  });

  it("ignores the marker when it is not at the start of a line", () => {
    expect(parseGatewayControlResultKind("see GATEWAY_CONTROL_RESULT=login_completed above")).toBeNull();
  });
});

describe("describeFreshLoginResult", () => {
  it("tells the user how long they have to approve the 2FA", () => {
    expect(describeFreshLoginResult("waiting_for_2fa")).toContain("3 minutes");
  });

  it("says nothing was restarted when the Gateway is already logged in", () => {
    expect(describeFreshLoginResult("refused_api_already_answering")).toMatch(/^Nothing was restarted/);
  });

  it("does not hide an unknown result", () => {
    expect(describeFreshLoginResult("something_new")).toContain("something_new");
  });
});
