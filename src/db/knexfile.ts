import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Knex } from "knex";

// Knex changes its working directory to this file's folder before running,
// so dotenv's default CWD-relative lookup won't find the project root .env.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadDotenv({ path: path.join(projectRoot, ".env") });

const sharedConfig: Partial<Knex.Config> = {
  client: "pg",
  migrations: {
    directory: "./migrations",
    // Locally this file runs as TS via tsx, resolving .ts migration files
    // directly. In production it runs compiled, as dist/src/db/knexfile.js
    // (tsx is a devDependency and gets pruned from the production slug), so
    // it needs to resolve the compiled .js migrations sitting next to it.
    extension: process.env.NODE_ENV === "production" ? "js" : "ts",
  },
};

const config: Record<string, Knex.Config> = {
  development: {
    ...sharedConfig,
    connection: process.env.DATABASE_URL,
  },
  test: {
    ...sharedConfig,
    connection: process.env.TEST_DATABASE_URL,
  },
  production: {
    ...sharedConfig,
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },
    pool: { min: 2, max: 10 },
  },
};

export default config;
