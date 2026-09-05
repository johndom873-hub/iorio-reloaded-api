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

export const environment = {
  nodeEnvironment: process.env.NODE_ENV ?? "development",
  databaseUrl: requireEnvironmentVariable("DATABASE_URL"),
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  sessionSecret: requireEnvironmentVariable("SESSION_SECRET"),
  frontendOrigin: requireEnvironmentVariable("FRONTEND_ORIGIN"),
  ibkrTradingMode: requireIbkrTradingMode(),
  ibkrTunnelSshHost: requireEnvironmentVariable("IBKR_TUNNEL_SSH_HOST"),
  ibkrTunnelSshPort: Number(requireEnvironmentVariable("IBKR_TUNNEL_SSH_PORT")),
  ibkrTunnelSshUsername: requireEnvironmentVariable("IBKR_TUNNEL_SSH_USERNAME"),
  ibkrTunnelSshPrivateKeyBase64: requireEnvironmentVariable("IBKR_TUNNEL_SSH_PRIVATE_KEY_BASE64"),
  ibkrGatewayHost: requireEnvironmentVariable("IBKR_GATEWAY_HOST"),
};
