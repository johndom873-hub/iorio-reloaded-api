import "dotenv/config";

export function requireEnvironmentVariable(variableName: string): string {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
}

function requireIbkrTradingMode(): "paper" | "live" {
  const value = requireEnvironmentVariable("IBKR_TRADING_MODE");
  if (value !== "paper" && value !== "live") {
    throw new Error(`IBKR_TRADING_MODE must be "paper" or "live", got: ${value}`);
  }
  return value;
}

export function requireBooleanEnvironmentVariable(variableName: string): boolean {
  const value = requireEnvironmentVariable(variableName);
  if (value !== "true" && value !== "false") {
    throw new Error(`${variableName} must be "true" or "false", got: ${value}`);
  }
  return value === "true";
}

/**
 * Whether this process may open IBKR market-data lines through the shared
 * line budget (marketDataLineBudget.ts). Read at call time, not at boot:
 * only the web dyno and the one-off jobs reserve lines (the VPS worker never
 * does), and the web dyno additionally validates it at startup (server.ts)
 * so a missing value fails loudly there. Local dev shares the paper login
 * with staging, so it keeps this "false" unless a live screen is being tested.
 */
export function ibkrMarketDataLinesEnabled(): boolean {
  return requireBooleanEnvironmentVariable("IBKR_MARKET_DATA_LINES_ENABLED");
}

export const environment = {
  nodeEnvironment: process.env.NODE_ENV ?? "development",
  databaseUrl: requireEnvironmentVariable("DATABASE_URL"),
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  frontendOrigin: requireEnvironmentVariable("FRONTEND_ORIGIN"),
  ibkrTradingMode: requireIbkrTradingMode(),
  ibkrTunnelSshHost: requireEnvironmentVariable("IBKR_TUNNEL_SSH_HOST"),
  ibkrTunnelSshPort: Number(requireEnvironmentVariable("IBKR_TUNNEL_SSH_PORT")),
  ibkrTunnelSshUsername: requireEnvironmentVariable("IBKR_TUNNEL_SSH_USERNAME"),
  ibkrTunnelSshPrivateKeyBase64: requireEnvironmentVariable("IBKR_TUNNEL_SSH_PRIVATE_KEY_BASE64"),
  ibkrGatewayHost: requireEnvironmentVariable("IBKR_GATEWAY_HOST"),
};
