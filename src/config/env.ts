import "dotenv/config";

function requireEnvironmentVariable(variableName: string): string {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
}

export const environment = {
  nodeEnvironment: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: requireEnvironmentVariable("DATABASE_URL"),
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-in-production",
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
};
